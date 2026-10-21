import { cookieFlag } from "./assignment.js";
import { carriedDimensions } from "./context.js";
import { firstRequestHoldoutUnit, observeTouchCookie } from "./touch-cookie.js";
import type { EdgePlan } from "./plan-types.js";
import type { TouchState } from "./touch-cookie.js";

/** `cookie` is the `Set-Cookie` value to append, or `null` when nothing may or needs to be written. */
export type Admission = { bypass: "consent" } | { touch: TouchState; cookie: string | null };

/** A consent project's plan (`version: 2`, `consent: "required"`) personalizes nothing until the tag has set `rm_consent=1`. */
export function consentMissing(plan: EdgePlan, cookieHeader: string): boolean {
  return (plan.consent === "required" || plan.version === 2) && !cookieFlag(cookieHeader, "rm_consent");
}

/**
 * Before consent the browser reads no cookie or storage, so a `_rm` landing is evaluated as a first page view:
 * the current query and referrer only, with no unit. Nothing is written.
 */
export function consentlessTouch(plan: EdgePlan, request: Request): TouchState {
  return observeTouchCookie("", plan.queryNames, request.url, request.headers.get("referer") ?? "").state;
}

/**
 * Consent, exclusion, unit minting and touch observation, for every adapter. Without required consent nothing
 * is observed, minted or written; the request bypasses unless `_rm` carries an accepted dimension, which the
 * walk then evaluates cookieless. A browser opted out with `rm_exclude=1` is observed for rule facts only: no
 * unit is minted and no cookie is written.
 */
export function admitRequest(plan: EdgePlan, request: Request, observe: typeof observeTouchCookie = observeTouchCookie): Admission {
  const header = request.headers.get("cookie") ?? "";
  if (consentMissing(plan, header)) return carriedDimensions(plan.dimensions, new URL(request.url)) ? { touch: consentlessTouch(plan, request), cookie: null } : { bypass: "consent" };
  const excluded = cookieFlag(header, "rm_exclude");
  const observation = observe(header, plan.queryNames, request.url, request.headers.get("referer") ?? "", null, [], excluded ? undefined : firstRequestHoldoutUnit(header));
  return { touch: observation.state, cookie: !excluded && observation.changed ? observation.cookie : null };
}
