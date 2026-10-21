import type { Dimension } from "./plan-types.js";

export const EDGE_SIGNAL_VERSION = 1;
export const EDGE_SIGNAL_KEY_LENGTH = 8;
export const EDGE_SIGNAL_MAX_AGE_DAYS = 30;

export interface ContextCookie {
  v?: 1;
  dims?: Record<string, unknown>;
  cid?: unknown;
  identityScope?: { project?: unknown; connection?: unknown };
  es?: unknown;
  /** Browser visitor id; an assignment unit only beside `ca` or `ab`. */
  vid?: unknown;
  /** Mirrored campaign arm ledger: `{v: 1, r: [[campaignId, exposed, holdback], ...]}`. */
  ca?: unknown;
  /** Mirrored test version ledger: `{v: 1, r: [[testId:run, exposed, versionId], ...]}`. */
  ab?: unknown;
  [key: string]: unknown;
}
export interface EdgeSignalSnapshot {
  v: 1;
  d: number;
  b: string;
  t: string;
  f: string;
  h?: string;
  ht?: string;
  hf?: string;
}
export interface EdgeSignalIdentity {
  project: string;
  connection: string;
  contactId: string;
  origin?: string;
  today?: number;
}

/** The query parameter a RightMessage link carries visitor context in, encoded like `_rm_ctx`. */
export const URL_CONTEXT_PARAM = "_rm";

function decodeContextValue(encoded: string): ContextCookie {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/").replace(/~/g, "=");
  const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0))));
  return payload && typeof payload === "object" && "v" in payload && payload.v === 1 ? payload as ContextCookie : {};
}

/** Decode the browser's UTF-8, URL-safe base64 `_rm_ctx` cookie. */
export function decodeContextCookie(cookie: string): ContextCookie {
  try {
    const encoded = cookie.split(";").map(x => x.trim()).find(x => x.startsWith("_rm_ctx="))?.slice(8);
    return encoded ? decodeContextValue(decodeURIComponent(encoded)) : {};
  } catch { return {}; }
}

/** Decode the first `_rm` query value, which `URLSearchParams` has already URL-decoded. */
export function decodeUrlContext(url: URL): ContextCookie {
  try {
    const encoded = url.searchParams.get(URL_CONTEXT_PARAM);
    return encoded ? decodeContextValue(encoded) : {};
  } catch { return {}; }
}

/**
 * The answered dimensions `_rm` carries, accepted as the tag accepts them from a URL: a dimension the plan
 * lacks, or one with signals and no question (`asked`), is ignored, and a segment outside its dimension is
 * dropped. Each accepted dimension replaces that dimension's answers. `null` when none is accepted.
 */
export function carriedDimensions(dimensions: readonly Dimension[], url: URL): Record<string, string[]> | null {
  const dims = decodeUrlContext(url).dims;
  if (!dims || typeof dims !== "object") return null;
  const carried: Record<string, string[]> = {};
  for (const [id, segmentIds] of Object.entries(dims)) {
    const dimension = dimensions.find(d => d.id === id);
    if (!dimension || !Array.isArray(dimension.segments) || (Array.isArray(dimension.signals) && dimension.signals.length > 0 && dimension.asked !== true)) continue;
    carried[id] = Array.isArray(segmentIds) ? segmentIds.filter((segmentId): segmentId is string => typeof segmentId === "string" && dimension.segments.some(segment => segment.id === segmentId)) : [];
  }
  return Object.keys(carried).length ? carried : null;
}

/** FNV-1a over UTF-16 code units; identity consistency, not authentication. */
export function edgeSignalBinding(project: string, scope: string, contactId: string): string {
  const input = `${project}\u0000${scope}\u0000${contactId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function edgeSignalsFresh(snapshot: unknown, today = Math.floor(Date.now() / 86400000)): boolean {
  if (!snapshot || typeof snapshot !== "object" || !("d" in snapshot)) return false;
  const day = snapshot.d;
  return typeof day === "number" && Number.isInteger(day) && day <= today && today - day <= EDGE_SIGNAL_MAX_AGE_DAYS;
}
const wellFormed = (value: unknown): value is string => typeof value === "string" && value.length % EDGE_SIGNAL_KEY_LENGTH === 0;

/** Conflicting keys are unknown; landing-page outcomes require an origin binding. */
export function decodeEdgeSignals(snapshot: unknown, { project, connection, contactId, origin, today = Math.floor(Date.now() / 86400000) }: EdgeSignalIdentity): Map<string, boolean> | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const data = snapshot as Record<string, unknown>;
  if (data.v !== EDGE_SIGNAL_VERSION || !edgeSignalsFresh(data, today) || !wellFormed(data.t) || !wellFormed(data.f)
    || !project || !connection || !contactId || data.b !== edgeSignalBinding(project, connection, contactId)) return null;
  const sections: [string, boolean][] = [[data.t, true], [data.f, false]];
  if (origin && wellFormed(data.ht) && wellFormed(data.hf) && data.h === edgeSignalBinding(project, origin, contactId)) sections.push([data.ht, true], [data.hf, false]);
  const outcomes = new Map<string, boolean>();
  const conflicts = new Set<string>();
  for (const [list, value] of sections) {
    for (let index = 0; index < list.length; index += EDGE_SIGNAL_KEY_LENGTH) {
      const key = list.slice(index, index + EDGE_SIGNAL_KEY_LENGTH);
      if (outcomes.has(key) && outcomes.get(key) !== value) conflicts.add(key);
      outcomes.set(key, value);
    }
  }
  for (const key of conflicts) outcomes.delete(key);
  return outcomes;
}
