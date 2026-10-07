import { HOLDOUT_UNIT_PATTERN, mintHoldoutUnit } from './holdout.js';

export const TOUCH_COOKIE_NAME = '__Host-rm_touch';
export const TOUCH_COOKIE_MAX_BYTES = 1024;
export interface TouchState { v?: 1; q: Record<string, [string, string]>; r?: string; u?: string }
export interface TouchPage { query?: Record<string, unknown>; _queryValuesDecoded?: boolean; referrer?: string }
export interface TouchObservation { state: TouchState; value: string; cookie: string; changed: boolean }
const namesFor = (queryNames: readonly string[]): string[] => [...new Set(queryNames.filter((name) => typeof name === 'string' && name !== '_rm_ctx'))].sort();
const emptyState = (): TouchState => ({ v: 1, q: {} });
const cookieValue = (header: string): string | null => {
  const prefix = `${TOUCH_COOKIE_NAME}=`;
  const entry = String(header || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return entry === undefined ? null : entry.slice(prefix.length);
};
const validHostname = (hostname: unknown): hostname is string => {
  if (typeof hostname !== 'string' || !hostname) return false;
  try {
    const url = new URL(`https://${hostname}`);
    return url.hostname === hostname && !url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
};

/**
 * A fresh holdout unit for a request carrying no RightMessage cookie, else `undefined`. Only such a
 * visitor is known to hold no recorded arm; pass the result to `observeTouchCookie`.
 */
export function firstRequestHoldoutUnit(header: string): string | undefined {
  const names = String(header || '').split(';').map((part) => part.trim().split('=')[0]);
  return names.includes(TOUCH_COOKIE_NAME) || names.includes('_rm_ctx') ? undefined : mintHoldoutUnit();
}

export function decodeTouchCookie(header: string, queryNames: readonly string[]): TouchState {
  const value = cookieValue(header);
  if (value === null || new TextEncoder().encode(`${TOUCH_COOKIE_NAME}=${value}`).length > TOUCH_COOKIE_MAX_BYTES) return emptyState();
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const state = parsed as Record<string, unknown>;
    if (state.v !== 1 || !state.q || typeof state.q !== 'object' || Array.isArray(state.q)) return emptyState();
    const source = state.q as Record<string, unknown>;
    const q = Object.fromEntries(namesFor(queryNames).flatMap((name): [string, [string, string]][] => {
      const pair = Object.hasOwn(source, name) ? source[name] : null;
      return Array.isArray(pair) && pair.length === 2 && pair.every((item: unknown) => typeof item === 'string') ? [[name, pair as [string, string]]] : [];
    }));
    return { v: 1, q, ...(state.r === '' || validHostname(state.r) ? { r: state.r } : {}), ...(typeof state.u === 'string' && HOLDOUT_UNIT_PATTERN.test(state.u) ? { u: state.u } : {}) };
  } catch { return emptyState(); }
}

const decodeQueryValueOnce = (value: string): string => {
  const plusNormalized = value.replace(/\+/g, ' ');
  try { return decodeURIComponent(plusNormalized); } catch { return plusNormalized; }
};
const queryOf = (page: TouchPage | null | undefined): Record<string, unknown> => {
  const query = page?.query && typeof page.query === 'object' && !Array.isArray(page.query) ? page.query : {};
  if (page?._queryValuesDecoded || page === null || page === undefined) return query;
  return Object.fromEntries(Object.entries(query).map(([name, value]) => [name, typeof value === 'string' ? decodeQueryValueOnce(value) : value]));
};

/**
 * Retain first/last observed allowlisted values and the first referrer hostname. `unit` is the
 * holdout unit to record when the cookie has none; an existing unit is never replaced.
 */
export function observeTouchCookie(header: string, queryNames: readonly string[], location: string | URL, referrer: string, firstPage: TouchPage | null = null, pages: readonly TouchPage[] = [], unit?: string): TouchObservation {
  const previous = cookieValue(header);
  const state = decodeTouchCookie(header, queryNames);
  const url = new URL(location);
  const query = Object.fromEntries(url.searchParams);
  const history = [firstPage, ...(Array.isArray(pages) ? pages : [])].map(queryOf);
  const observed = (name: string): string[] => history.flatMap(q => Object.hasOwn(q, name) && typeof q[name] === 'string' ? [q[name]] : []);
  state.q = Object.fromEntries(namesFor(queryNames).flatMap((name): [string, [string, string]][] => {
    const previousPair = Object.hasOwn(state.q, name) ? state.q[name] : null;
    const current = Object.hasOwn(query, name) ? query[name] : null;
    const values = previousPair ? [] : observed(name);
    const historical: [string, string] | null = values.length ? [values[0]!, values[values.length - 1]!] : null;
    const pair: [string, string] | null | undefined = current == null ? previousPair || historical : [previousPair ? previousPair[0] : (historical?.[0] ?? current), current];
    return pair ? [[name, pair]] : [];
  }));
  const firstReferrer = typeof firstPage?.referrer === 'string' ? firstPage.referrer : referrer;
  if (!Object.hasOwn(state, 'r') && !firstReferrer) state.r = '';
  if (!Object.hasOwn(state, 'r') && firstReferrer) {
    try {
      const source = new URL(firstReferrer);
      if (['https:', 'http:'].includes(source.protocol) && validHostname(source.hostname)) state.r = source.hostname === url.hostname ? '' : source.hostname;
    } catch {}
  }
  if (!state.u && unit !== undefined && HOLDOUT_UNIT_PATTERN.test(unit)) state.u = unit;
  // Canonical key order keeps edge- and browser-written values byte-identical.
  const encode = () => encodeURIComponent(JSON.stringify({ v: 1, q: state.q, ...(Object.hasOwn(state, 'r') ? { r: state.r } : {}), ...(state.u ? { u: state.u } : {}) }));
  let value = encode();
  const remaining = Object.keys(state.q).sort();
  while (TOUCH_COOKIE_NAME.length + 1 + value.length > TOUCH_COOKIE_MAX_BYTES) {
    const name = remaining.pop();
    if (name !== undefined) delete state.q[name];
    else delete state.r;
    value = encode();
  }
  return { state, value, cookie: `${TOUCH_COOKIE_NAME}=${value}; Secure; Path=/; SameSite=Lax`, changed: previous !== null ? previous !== value : Object.keys(state.q).length > 0 || Object.hasOwn(state, 'r') };
}
