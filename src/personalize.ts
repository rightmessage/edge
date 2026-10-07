import { boundedBytes, SOURCE_CAP } from './bytes.js';
import { evaluatePlan } from './edge-plan.js';
import { firstRequestHoldoutUnit, observeTouchCookie } from './touch-cookie.js';
import { transformHTML } from './transform.js';
import type { PlanLoad } from './plan-load.js';
import type { HTMLRewriterConstructor } from './rewriter-types.js';

export interface PersonalizeDependencies {
  HTMLRewriter: HTMLRewriterConstructor;
  observeTouchCookie?: typeof observeTouchCookie;
  log?: (message: string, details: { reason: string }) => void;
}
function privateHeaders(headers: Headers, cookie: string | null, transformed = false): Headers {
  const next = new Headers(headers);
  next.set('cache-control', 'private, no-store');
  next.set('cdn-cache-control', 'no-store');
  next.set('cloudflare-cdn-cache-control', 'no-store');
  if (cookie) next.append('set-cookie', cookie);
  if (transformed) for (const name of ['content-length', 'etag', 'last-modified', 'content-md5', 'digest', 'content-encoding']) next.delete(name);
  return next;
}

export async function personalizeResponse(request: Request, origin: Response, planLoad: PlanLoad, dependencies: PersonalizeDependencies): Promise<Response> {
  const url = new URL(request.url);
  const log = dependencies.log ?? ((message, details) => console.log(message, details));
  const isHTML = origin.headers.get('content-type')?.toLowerCase().includes('text/html');
  const bypass = (reason: string, cookie: string | null = null) => {
    planLoad.abort();
    log('RightMessage edge bypass', { reason });
    const headers = cookie ? privateHeaders(origin.headers, cookie) : new Headers(origin.headers);
    headers.set('x-rm-edge', `bypass:${reason}`);
    return new Response(origin.body, { status: origin.status, statusText: origin.statusText, headers });
  };
  if (!isHTML) { planLoad.abort(); return origin; }
  if (planLoad.bypassReason) return bypass(planLoad.bypassReason);
  if (origin.status !== 200) return bypass('origin-status');
  if (/charset=(?!utf-8|utf8)/i.test(origin.headers.get('content-type') ?? '')) return bypass('unsupported-charset');
  const outcome = await planLoad.promise;
  if (!outcome.loaded) return bypass(outcome.reason);
  let observation;
  try {
    const header = request.headers.get('cookie') ?? '';
    observation = (dependencies.observeTouchCookie ?? observeTouchCookie)(header, outcome.loaded.plan.queryNames, url.href, request.headers.get('referer') ?? '', null, [], firstRequestHoldoutUnit(header));
  } catch { return bypass('attribution-failed'); }
  const cookie = observation.changed ? observation.cookie : null;
  try {
    const actions = evaluatePlan(outcome.loaded.plan, request, observation.state);
    if (!actions.length) return bypass(cookie ? 'cookie-only' : 'no-actions', cookie);
    if (Number(origin.headers.get('content-length')) > SOURCE_CAP) return bypass('oversized', cookie);
    const bytes = await boundedBytes(origin.clone(), SOURCE_CAP);
    const output = await transformHTML(bytes, actions, outcome.loaded.release, dependencies.HTMLRewriter);
    if (!output) return bypass(cookie ? 'cookie-only' : 'no-actions', cookie);
    if (origin.body) void origin.body.cancel().catch(() => {});
    const headers = privateHeaders(origin.headers, cookie, true);
    headers.set('x-rm-edge', 'applied');
    return new Response(output, { status: origin.status, statusText: origin.statusText, headers });
  } catch (error) {
    return bypass(error instanceof Error && error.message === 'Personalization buffer limit' ? 'oversized' : 'transform-failed', cookie);
  }
}
