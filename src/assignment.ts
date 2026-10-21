import type { ContextCookie } from "./context.js";
import type { Campaign, PlanAbTest, VersionId } from "./plan-types.js";

// Mirrors the browser tag's assignment (`resources/js/Shared/campaignHoldout.js` in the
// RightMessage application). Both sides hash the same visitor unit, so a campaign arm or a test
// version the visitor has no record for lands on the same value at the edge and in the browser.
const HOLDOUT_SALT = "rm-holdout-v1";
const AB_TEST_SALT = "rm-abtest-v1";
export const HOLDOUT_UNIT_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_LEDGER_RECORDS = 128;
const TEST_KEY_PATTERN = /^abt_[A-Za-z0-9]+:abr_[A-Za-z0-9]+$/;
const MAX_TEST_KEY_LENGTH = 256;
const VERSION_IDS: readonly VersionId[] = ["A", "B", "C", "D"];
const isVersionId = (value: unknown): value is VersionId => VERSION_IDS.some(id => id === value);

/** Uniform point in [0, 100): FNV-1a over UTF-16 code units, finalized with murmur3 fmix32. */
function point(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return ((hash >>> 0) / 4294967296) * 100;
}

/** The campaign holdout point; below `withhold || 10` holds the visitor out. */
export function holdoutPoint(unit: string, campaignId: string): number {
  return point(`${HOLDOUT_SALT}\u0000${unit}\u0000${campaignId}`);
}

/** `nodeId` is the audience id, or `original` for the campaign's Original layer. */
export function abTestVersionPoint(unit: string, campaignId: string, nodeId: string, testId: string, run: string): number {
  return point(`${AB_TEST_SALT}\u0000${unit}\u0000${campaignId}\u0000${nodeId}\u0000${testId}\u0000${run}`);
}

/** The first version, in A..D order, whose cumulative weight exceeds the point. */
export function assignAbTestVersion(weights: Partial<Record<VersionId, number>>, point: number): VersionId {
  if (!Number.isFinite(point) || point < 0 || point >= 100) throw new Error("A/B test assignment point must be between 0 and 100 (exclusive).");
  let cumulative = 0;
  for (const id of VERSION_IDS) {
    const weight = weights[id];
    if (weight === undefined) continue;
    cumulative += weight;
    if (point < cumulative) return id;
  }
  throw new Error("A/B test weights must cover the assignment point.");
}

/** Integers 1..99 summing to 100 over a subset of A..D that includes A. */
function validWeights(weights: unknown): weights is Partial<Record<VersionId, number>> {
  if (!weights || typeof weights !== "object" || Array.isArray(weights)) return false;
  const entries = Object.entries(weights);
  if (!Object.hasOwn(weights, "A")) return false;
  let total = 0;
  for (const [id, weight] of entries) {
    if (!isVersionId(id) || typeof weight !== "number" || !Number.isInteger(weight) || weight < 1 || weight > 99) return false;
    total += weight;
  }
  return total === 100;
}

/** 128 random bits, base64url: the unit the edge mints for a visitor it has never seen. */
export function mintHoldoutUnit(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A ledger's valid records, keyed by their first item. Keys recorded twice are dropped, as in the browser. */
function decodeLedger<T>(ledger: unknown, record: (item: unknown[]) => [string, T] | null): Map<string, T> | null {
  const value = ledger as { v?: unknown; r?: unknown } | undefined;
  if (!value || typeof value !== "object" || value.v !== 1 || !Array.isArray(value.r) || value.r.length > MAX_LEDGER_RECORDS) return null;
  const records = new Map<string, T>();
  const duplicates = new Set<string>();
  for (const item of value.r as unknown[]) {
    const decoded = Array.isArray(item) && item.length === 3 ? record(item) : null;
    if (!decoded) continue;
    if (records.has(decoded[0])) duplicates.add(decoded[0]);
    records.set(decoded[0], decoded[1]);
  }
  for (const key of duplicates) records.delete(key);
  return records;
}

/** Recorded arms from `_rm_ctx.ca` (`[campaignId, exposed, holdback]`). */
export function decodeCampaignArms(context: ContextCookie): Map<string, boolean> | null {
  return decodeLedger(context.ca, ([campaignId, exposed, holdback]) =>
    typeof campaignId === "string" && campaignId && typeof exposed === "boolean" && typeof holdback === "boolean" ? [campaignId, holdback] : null);
}

/** Recorded versions from `_rm_ctx.ab` (`[testId:run, exposed, versionId]`), with the tag's `crossDomain.js` validity rules. */
export function decodeTestVersions(context: ContextCookie): Map<string, VersionId> | null {
  return decodeLedger(context.ab, ([key, exposed, versionId]) =>
    typeof key === "string" && key.length <= MAX_TEST_KEY_LENGTH && TEST_KEY_PATTERN.test(key) && typeof exposed === "boolean" && isVersionId(versionId) ? [key, versionId] : null);
}

/**
 * The unit both sides hash: the edge-minted touch unit, else the browser's visitor id. The visitor
 * id is used only beside a mirrored ledger (`ca` or `ab`): a context without one may predate the
 * mirror and hide recorded arms or versions the edge would contradict.
 */
export function assignmentUnit(touchUnit: string | undefined, context: ContextCookie): string | null {
  if (typeof touchUnit === "string" && HOLDOUT_UNIT_PATTERN.test(touchUnit)) return touchUnit;
  if (typeof context.vid !== "string" || !context.vid) return null;
  return decodeCampaignArms(context) || decodeTestVersions(context) ? context.vid : null;
}

/** True when the header has at least one `name=` entry and every one of them is exactly `1`. */
export function cookieFlag(header: string, name: string): boolean {
  let seen = false;
  for (const part of header.split(";")) {
    const entry = part.trim();
    const equals = entry.indexOf("=");
    if (equals === -1 || entry.slice(0, equals) !== name) continue;
    if (entry.slice(equals + 1) !== "1") return false;
    seen = true;
  }
  return seen;
}

/**
 * `debug`: the tag's debugger (`?debug=true|yes`, last value wins) renders treatment for every
 * campaign and pins test versions in session storage the edge cannot see. `excluded`: the browser
 * opted out with `rm_exclude=1` renders treatment and version A everywhere. `off`: before required
 * consent the tag's assignment is off, which renders the same and reads no cookie.
 */
export type VisitorMode = "debug" | "excluded" | "off" | "normal";
export function visitorMode(url: URL, cookieHeader: string, consentMissing = false): VisitorMode {
  const debug = url.searchParams.getAll("debug").at(-1);
  if (debug === "true" || debug === "yes") return "debug";
  if (consentMissing) return "off";
  return cookieFlag(cookieHeader, "rm_exclude") ? "excluded" : "normal";
}

/** The visitor's recorded and hashed choices for one request. */
export interface Assignment {
  mode: VisitorMode;
  arms: Map<string, boolean> | null;
  versions: Map<string, VersionId> | null;
  unit: string | null;
}
export function requestAssignment(mode: VisitorMode, context: ContextCookie, touchUnit: string | undefined): Assignment {
  return { mode, arms: decodeCampaignArms(context), versions: decodeTestVersions(context), unit: assignmentUnit(touchUnit, context) };
}

/** `true` holds the visitor out, `false` is the treatment arm, `null` is unknown (the browser decides). */
export function campaignHoldback(campaign: Campaign, assignment: Assignment): boolean | null {
  if (assignment.mode !== "normal") return false;
  const recorded = assignment.arms?.get(campaign.id);
  if (recorded !== undefined) return recorded;
  const testing = campaign.testing as { is_enabled?: unknown; withhold?: unknown } | undefined;
  if (!testing?.is_enabled) return false;
  if (assignment.unit === null) return null;
  return holdoutPoint(assignment.unit, campaign.id) < Number(testing.withhold || 10);
}

/**
 * The version a running test renders, or `null` when the edge cannot know it. A recorded version
 * wins over the hash, as in the browser, but one the weights lack is never guessed.
 */
export function drawVersion(campaignId: string, nodeId: string, test: Extract<PlanAbTest, { state: "running" }>, assignment: Assignment): VersionId | null {
  if (assignment.mode === "excluded" || assignment.mode === "off") return "A";
  if (!validWeights(test.weights)) return null;
  const recorded = assignment.versions?.get(`${test.id}:${test.run}`);
  if (recorded !== undefined) return Object.hasOwn(test.weights, recorded) ? recorded : null;
  if (assignment.unit === null) return null;
  return assignAbTestVersion(test.weights, abTestVersionPoint(assignment.unit, campaignId, nodeId, test.id, test.run));
}
