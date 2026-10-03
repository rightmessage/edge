export const EDGE_SIGNAL_VERSION = 1;
export const EDGE_SIGNAL_KEY_LENGTH = 8;
export const EDGE_SIGNAL_MAX_AGE_DAYS = 30;

export interface ContextCookie {
  v?: 1;
  dims?: Record<string, unknown>;
  cid?: unknown;
  identityScope?: { project?: unknown; connection?: unknown };
  es?: unknown;
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

/** Decode the browser's UTF-8, URL-safe base64 `_rm_ctx` cookie. */
export function decodeContextCookie(cookie: string): ContextCookie {
  try {
    const encoded = cookie.split(";").map(x => x.trim()).find(x => x.startsWith("_rm_ctx="))?.slice(8);
    if (!encoded) return {};
    const base64 = decodeURIComponent(encoded).replace(/-/g, "+").replace(/_/g, "/").replace(/~/g, "=");
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0))));
    return payload && typeof payload === "object" && "v" in payload && payload.v === 1 ? payload as ContextCookie : {};
  } catch { return {}; }
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
