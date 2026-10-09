import { boundedBytes, SOURCE_CAP } from './bytes.js';
import type { EdgePlan, Release } from './plan-types.js';

export const SUPPORTED_PLAN_VERSIONS: readonly number[] = Object.freeze([1]);
export const PLAN_TIMEOUT_MS = 300;
export const RELEASE_FRESH_MS = 20_000;
export const NEGATIVE_TTL_MS = 3_000;
const SHARED_LOAD_CEILING_MS = 5_000;

export interface EdgeConfig {
  teamPid: string;
  tagOrigin?: string;
  enabled?: boolean;
  allowRsc?: boolean;
}
export type Fetch = (request: Request) => Response | Promise<Response>;
export interface ExecutionContext { waitUntil(promise: Promise<unknown>): void }
export interface LoadedPlan { plan: EdgePlan; release: Release }
export type PlanOutcome = { loaded: LoadedPlan; reason?: never } | { reason: string; loaded?: never };
export interface PlanLoad { promise: Promise<PlanOutcome>; abort(): void; readonly bypassReason?: string }
export interface PlanLoadDependencies { fetch?: Fetch; planCache?: PlanCache; planTimeoutMs?: number }
interface ValidConfig { origin: string; pid: string; key: string }
type CacheHit = { loaded: LoadedPlan; load?: never; reason?: never } | { reason: string; load?: never; loaded?: never } | { load: Promise<LoadedPlan>; loaded?: never; reason?: never };
export interface PlanCache {
  lookup(fetcher: Fetch, config: ValidConfig, waitUntil?: (promise: Promise<unknown>) => void): CacheHit;
  revisions(): string[];
}
class PlanLoadError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
const reasonOf = (error: unknown) => error instanceof PlanLoadError ? error.reason : 'plan-unavailable';

export function requestBypassReason(request: Request, config: Pick<EdgeConfig, 'enabled' | 'allowRsc'> = {}): string | null {
  if (config.enabled === false) return 'not-production';
  if (request.method !== 'GET') return 'request-method';
  if (!config.allowRsc && request.headers.has('rsc')) return 'rsc';
  const url = new URL(request.url);
  if (['preview', 'rmpreview', '__rm_test', 'rmeditor'].some(name => url.searchParams.has(name))) return 'preview';
  // The tag's draft-preview session cookie: the browser runs the draft, never the published plan.
  if (/(?:^|;\s*)rm_preview=1(?:;|$)/.test(request.headers.get('cookie') ?? '')) return 'preview';
  return null;
}
function tagConfig(config: EdgeConfig): ValidConfig {
  let origin: URL;
  try { origin = new URL(config.tagOrigin ?? 'https://t.rightmessage.com'); }
  catch { throw new PlanLoadError('invalid-plan'); }
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) throw new PlanLoadError('invalid-plan');
  const pid = String(config.teamPid);
  if (!/^[a-zA-Z0-9_-]+$/.test(pid)) throw new PlanLoadError('invalid-plan');
  return { origin: origin.origin, pid, key: `${origin.origin}/${pid}` };
}
async function fetchPlanResource(fetcher: Fetch, request: Request, signal: AbortSignal): Promise<Response> {
  try { return await fetcher(new Request(request, { signal })); }
  catch (error) { if (signal.aborted) throw error; throw new PlanLoadError('plan-unavailable'); }
}
async function loadRelease(fetcher: Fetch, { origin, pid }: ValidConfig, signal: AbortSignal): Promise<Release> {
  const response = await fetchPlanResource(fetcher, new Request(`${origin}/${pid}/release.json`, { headers: { accept: 'application/json' }, cache: 'no-store' }), signal);
  if (!response.ok) throw new PlanLoadError('plan-unavailable');
  let release: Release;
  try { release = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 8192))) as Release; }
  catch { throw new PlanLoadError('invalid-plan'); }
  if (!release || release.version !== 1 || release.teamPid !== pid || !/^[a-f0-9]{64}$/.test(release.revision)) throw new PlanLoadError('invalid-plan');
  if (release.planUrl !== `${origin}/${pid}/revisions/${release.revision}/plan.json` || release.loaderUrl !== `${origin}/${pid}.js?revision=${release.revision}`) throw new PlanLoadError('invalid-plan');
  return release;
}
async function loadRevisionPlan(fetcher: Fetch, { pid }: ValidConfig, release: Release, signal: AbortSignal): Promise<EdgePlan> {
  const result = await fetchPlanResource(fetcher, new Request(release.planUrl, { headers: { accept: 'application/json' } }), signal);
  if (!result.ok) throw new PlanLoadError('plan-unavailable');
  let plan: EdgePlan;
  try { plan = JSON.parse(new TextDecoder().decode(await boundedBytes(result, SOURCE_CAP))) as EdgePlan; }
  catch { throw new PlanLoadError('invalid-plan'); }
  if (!plan || !SUPPORTED_PLAN_VERSIONS.includes(plan.version) || plan.teamPid !== pid || !Array.isArray(plan.queryNames) || !plan.queryNames.every(name => typeof name === 'string' && name !== '_rm_ctx') || !Array.isArray(plan.dimensions) || !Array.isArray(plan.campaigns)) throw new PlanLoadError('invalid-plan');
  return plan;
}

export function createPlanCache({ now = Date.now }: { now?: () => number } = {}): PlanCache {
  let current: (LoadedPlan & { key: string; fetchedAt: number }) | null = null;
  let failure: { key: string; reason: string; until: number } | null = null;
  let inflight: { key: string; promise: Promise<LoadedPlan> } | null = null;
  const plans = new Map<string, EdgePlan>();
  const remember = (key: string, release: Release, plan: EdgePlan) => {
    plans.delete(release.revision);
    plans.set(release.revision, plan);
    for (const revision of plans.keys()) {
      if (plans.size <= 2) break;
      if (revision !== release.revision && revision !== current?.release.revision) plans.delete(revision);
    }
    current = { key, release, plan, fetchedAt: now() };
    failure = null;
  };
  const sharedLoad = (fetcher: Fetch, config: ValidConfig): Promise<LoadedPlan> => {
    if (inflight?.key === config.key) return inflight.promise;
    const controller = new AbortController();
    const ceiling = setTimeout(() => controller.abort(), SHARED_LOAD_CEILING_MS);
    const promise = (async () => {
      const release = await loadRelease(fetcher, config, controller.signal);
      const plan = plans.get(release.revision) ?? await loadRevisionPlan(fetcher, config, release, controller.signal);
      remember(config.key, release, plan);
      return { plan, release };
    })().catch((error: unknown) => {
      const reason = controller.signal.aborted ? 'plan-timeout' : reasonOf(error);
      failure = { key: config.key, reason, until: now() + NEGATIVE_TTL_MS };
      throw new PlanLoadError(reason);
    }).finally(() => {
      clearTimeout(ceiling);
      if (inflight?.promise === promise) inflight = null;
    });
    inflight = { key: config.key, promise };
    return promise;
  };
  return {
    lookup(fetcher, config, waitUntil) {
      const failing = failure?.key === config.key && failure.until > now();
      if (current?.key === config.key) {
        if (now() - current.fetchedAt >= RELEASE_FRESH_MS && !failing && !inflight) {
          const refresh = sharedLoad(fetcher, config).catch(() => {});
          waitUntil?.(refresh);
        }
        return { loaded: { plan: current.plan, release: current.release } };
      }
      if (failing && failure) return { reason: failure.reason };
      const load = sharedLoad(fetcher, config);
      waitUntil?.(load.catch(() => {}));
      return { load };
    },
    revisions: () => [...plans.keys()],
  };
}
const isolateCache = createPlanCache();
const immediate = (outcome: PlanOutcome): PlanLoad => ({ promise: Promise.resolve(outcome), abort() {} });

export function startPlanLoad(request: Request, config: EdgeConfig, dependencies: PlanLoadDependencies = {}, ctx?: ExecutionContext): PlanLoad {
  const bypass = requestBypassReason(request, config);
  if (bypass) return { ...immediate({ reason: bypass }), bypassReason: bypass };
  let valid: ValidConfig;
  try { valid = tagConfig(config); }
  catch (error) { return immediate({ reason: reasonOf(error) }); }
  const hit = (dependencies.planCache ?? isolateCache).lookup(dependencies.fetch ?? globalThis.fetch, valid, ctx?.waitUntil?.bind(ctx));
  if (!hit.load) return immediate(hit);
  let timeout: ReturnType<typeof setTimeout>;
  const promise = Promise.race<PlanOutcome>([
    hit.load.then(loaded => ({ loaded }), error => ({ reason: reasonOf(error) })),
    new Promise(resolve => { timeout = setTimeout(() => resolve({ reason: 'plan-timeout' }), dependencies.planTimeoutMs ?? PLAN_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timeout));
  return { promise, abort() { clearTimeout(timeout); } };
}
