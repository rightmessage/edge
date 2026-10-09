import type { ContextCookie } from "./context.js";
import type { Campaign } from "./plan-types.js";

// Mirrors the browser tag's campaign holdout assignment (`resources/js/Shared/campaignHoldout.js`
// in the RightMessage application). Both sides hash the same visitor unit, so a campaign the
// visitor has no recorded arm for lands on the same arm at the edge and in the browser.
const SALT = "rm-holdout-v1";
export const HOLDOUT_UNIT_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_CAMPAIGN_RECORDS = 128;

/** Uniform point in [0, 100): FNV-1a over UTF-16 code units, finalized with murmur3 fmix32. */
export function holdoutPoint(unit: string, campaignId: string): number {
  const input = `${SALT}\u0000${unit}\u0000${campaignId}`;
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

/** 128 random bits, base64url: the unit the edge mints for a visitor it has never seen. */
export function mintHoldoutUnit(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Recorded arms from `_rm_ctx.ca` (`[campaignId, exposed, holdback]`); duplicated ids are dropped, as in the browser. */
export function decodeCampaignArms(context: ContextCookie): Map<string, boolean> | null {
  const ca = context.ca as { v?: unknown; r?: unknown } | undefined;
  if (!ca || typeof ca !== "object" || ca.v !== 1 || !Array.isArray(ca.r) || ca.r.length > MAX_CAMPAIGN_RECORDS) return null;
  const arms = new Map<string, boolean>();
  const duplicates = new Set<string>();
  for (const record of ca.r as unknown[]) {
    if (!Array.isArray(record) || record.length !== 3 || typeof record[0] !== "string" || !record[0] || typeof record[1] !== "boolean" || typeof record[2] !== "boolean") continue;
    if (arms.has(record[0])) duplicates.add(record[0]);
    arms.set(record[0], record[2]);
  }
  for (const id of duplicates) arms.delete(id);
  return arms;
}

/**
 * The unit both sides hash: the edge-minted touch unit, else the browser's visitor id. The visitor
 * id is used only beside a mirrored ledger (`ca`): a context without one may predate it and hide
 * recorded arms the edge would contradict.
 */
export function holdoutUnit(touchUnit: string | undefined, context: ContextCookie): string | null {
  if (typeof touchUnit === "string" && HOLDOUT_UNIT_PATTERN.test(touchUnit)) return touchUnit;
  return decodeCampaignArms(context) && typeof context.vid === "string" && context.vid ? context.vid : null;
}

/** `true` holds the visitor out, `false` is the treatment arm, `null` is unknown (the browser decides). */
export function campaignHoldback(campaign: Campaign, arms: Map<string, boolean> | null, unit: string | null): boolean | null {
  const recorded = arms?.get(campaign.id);
  if (recorded !== undefined) return recorded;
  const testing = campaign.testing as { is_enabled?: unknown; withhold?: unknown } | undefined;
  if (!testing?.is_enabled) return false;
  if (unit === null) return null;
  return holdoutPoint(unit, campaign.id) < Number(testing.withhold || 10);
}

/**
 * The browser tag's debugger (`?debug=true` or `?debug=yes`, last value wins) always renders the
 * treatment arm without recording it, so the edge personalizes every tested campaign for it too.
 */
export function debugForcesTreatment(url: URL): boolean {
  const value = url.searchParams.getAll("debug").at(-1);
  return value === "true" || value === "yes";
}
