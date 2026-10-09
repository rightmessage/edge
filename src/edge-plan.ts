import { decodeContextCookie, decodeEdgeSignals } from "./context.js";
import { campaignHoldback, debugForcesTreatment, decodeCampaignArms, holdoutUnit } from "./holdout.js";
import type { Action, Decision, EdgePlan, EdgeRequest, EvaluationTime, PageCriterion, Rule, RuleObject } from "./plan-types.js";
import type { TouchState } from "./touch-cookie.js";

// Mirrors the published browser rule vocabulary. Unknown browser inputs must never
// become false: doing so could choose a later single-winning segment incorrectly.
type Truth = boolean | null;
const UNKNOWN = null;

const and = (a: Truth, b: Truth): Truth => a === false || b === false ? false : a === UNKNOWN || b === UNKNOWN ? UNKNOWN : true;
const or = (a: Truth, b: Truth): Truth => a === true || b === true ? true : a === UNKNOWN || b === UNKNOWN ? UNKNOWN : false;
const glob = (value: string, pattern: unknown): boolean => new RegExp(`^${String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value);
const hostnameMatchesDomain = (hostname: string | undefined, domain: string): boolean => {
  const pattern = domain.toLowerCase();
  if (!hostname || !pattern) return false;
  return pattern.includes("*") ? glob(hostname, pattern) : hostname === pattern || hostname.endsWith(`.${pattern}`);
};

function compare(value: unknown, operator: string | undefined, expected: unknown, type = "string"): Truth {
  if (type === "array") {
    const values = (value || []) as { length: number; [index: number]: unknown };
    let includes = false;
    for (let index = 0; index < values.length; index++) if (values[index] == expected) includes = true;
    const expectedValues = expected;
    const includesAny = Array.isArray(values) && values.length > 0 && Array.isArray(expectedValues) && expectedValues.length > 0
      && values.some(item => expectedValues.includes(item));
    switch (operator) {
      case "include": case "includes": return includes;
      case "do not include": case "does not include": return !includes;
      case "include any": case "includes any": return includesAny;
      case "do not include any": case "does not include any": return !includesAny;
      case "is set": return values.length > 0;
      case "is not set": return values.length === 0;
      default: return UNKNOWN;
    }
  }
  if (type === "path") {
    if (operator === "contains" && typeof expected === "string" && expected.startsWith("/") && expected.endsWith("/")) {
      if (typeof value === "string" && !value.startsWith("/")) value = `/${value}`;
    } else {
      if (typeof value === "string") value = value.replace(/(^\/*|\/*$)/g, "");
      if (typeof expected === "string") expected = expected.replace(/(^\/*|\/*$)/g, "");
    }
  }
  const original = value;
  value = value ?? "";
  if (typeof value === "boolean") value = String(value);
  const numeric = original == null || original === "" ? NaN : Number(value);
  const numericExpected = Number(expected);
  if (!Number.isNaN(numeric) && !Number.isNaN(numericExpected)) {
    value = numeric;
    expected = numericExpected;
  }
  const values = typeof expected === "string" ? expected.split(",").map(x => x.trim()).filter(Boolean) : [expected || ""];
  if (!values.length) values.push("");
  switch (operator) {
    case "equals": return values.some(x => value == x);
    case "does not equal": return values.every(x => value != x);
    case "is set": return value !== "";
    case "is not set": return value === "";
    case "gt": return numeric > numericExpected;
    case "gte": return numeric >= numericExpected;
    case "lt": return numeric < numericExpected;
    case "lte": return numeric <= numericExpected;
  }
  if (typeof original !== "string" || typeof value !== "string" || typeof expected !== "string") {
    value = "";
    expected = "x";
  }
  const text = value as string;
  const patterns = (expected as string).split(",").map(x => x.trim()).filter(Boolean);
  if (!patterns.length) patterns.push("");
  switch (operator) {
    case "contains": return patterns.some(x => text.includes(x));
    case "does not contain": return patterns.every(x => !text.includes(x));
    case "starts with": return patterns.some(x => text.startsWith(x));
    case "ends with": return patterns.some(x => text.endsWith(x));
    case "glob": return patterns.some(x => glob(text, x));
    default: return UNKNOWN;
  }
}

const timestamp = (value: unknown): number => Math.floor(new Date(value as string | number).getTime() / 1000);

interface LocalDateParts { year: number; month: number; day: number; weekday: number }
interface LocalClock {
  current: LocalDateParts;
  nowSeconds: number;
  parts(value: unknown): LocalDateParts | null;
}
function createLocalClock(now: EvaluationTime, timeZone: unknown): LocalClock | null {
  if (typeof timeZone !== "string" || !timeZone) return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
    });
    const parts = (value: unknown) => {
      const date = new Date(value as string | number);
      if (Number.isNaN(date.getTime())) return null;
      const fields = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
      const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(fields.weekday!);
      if (weekday < 0) return null;
      return { year: Number(fields.year), month: Number(fields.month) - 1, day: Number(fields.day), weekday };
    };
    const current = parts(now);
    return current ? { current, nowSeconds: timestamp(now), parts } : null;
  } catch {
    return null;
  }
}

function evaluateDateRule(rule: RuleObject, clock: LocalClock): boolean {
  if (rule.$type === "weekday" || rule.$type === "month") {
    const current = String(rule.$type === "weekday" ? clock.current.weekday : clock.current.month);
    const result = compare(rule.value, rule.operator, [current], "array");
    return result === UNKNOWN ? false : result;
  }
  if (rule.$type !== "date" || !rule.value || !rule.operator) return false;
  if (rule.operator === "ever") return true;
  const relative = rule.operator.match(/^(outside )?this (\d+) (week|day|hour|minute)s?$/);
  if (relative) {
    const seconds = Number(relative[2]) * ({ week: 604800, day: 86400, hour: 3600, minute: 60 } as Record<string, number>)[relative[3]!]!;
    const within = Number(rule.value) >= clock.nowSeconds - seconds;
    return relative[1] ? !within : within;
  }
  if (rule.operator === "equals") {
    const value = clock.parts(rule.value);
    return !!value && value.year === clock.current.year && value.month === clock.current.month && value.day === clock.current.day;
  }
  const value = timestamp(rule.value);
  if (rule.operator === "before") return value > clock.nowSeconds;
  if (rule.operator === "after") return value < clock.nowSeconds;
  if (rule.operator === "between") return clock.nowSeconds >= value && clock.nowSeconds <= timestamp(rule.dateEnd);
  return false;
}

// Mirrors partner.js check() against the empty profile the browser holds for an
// anonymous visitor: no fields/tags/lists/events/purchases, _isAnonymous true,
// revenue 0. Unrecognized types stay unknown.
function evaluateAnonymousIntegrationRule(rule: RuleObject): Truth {
  switch (rule.$type) {
    case "customField":
      if (rule.operator === "is set") return false;
      if (rule.operator === "is not set") return true;
      return false;
    case "tags":
    case "lists":
    case "purchaseHistory": {
      const result = compare([], rule.operator, rule.$type === "tags" ? rule.tagIds : rule.$type === "lists" ? rule.listIds : rule.productIds, "array");
      return result === UNKNOWN ? false : result;
    }
    case "isAnonymous": return true;
    case "isSubscriber": return false;
    case "eventHistory": {
      // partner.js compares the raw `logic.count || 0`: relational operators
      // coerce strings, while equals is strict (so "0" never equals 0).
      const count = rule.count || 0;
      switch (rule.operator) {
        case "has_fired": return false;
        case "has_not_fired": return true;
        case "gte": return 0 >= Number(count);
        case "lt": return 0 < Number(count);
        case "equals": return count === 0;
        default: return false;
      }
    }
    case "totalRevenue": {
      const expected = Number(rule.value);
      switch (rule.operator) {
        case "equals": return expected === 0;
        case "does not equal": return expected !== 0;
        case "gt": return 0 > expected;
        case "gte": return 0 >= expected;
        case "lt": return 0 < expected;
        case "lte": return 0 <= expected;
        default: return UNKNOWN;
      }
    }
    default: return UNKNOWN;
  }
}

function matchesQueryValue(value: unknown, rule: RuleObject): Truth {
  const normalized = typeof rule.value === "string" ? rule.value.replace(/\+/g, " ") : rule.value;
  let decoded = normalized;
  try { if (typeof normalized === "string") decoded = decodeURIComponent(normalized); } catch {}
  const results = [normalized, decoded].map(expected => compare(value, rule.operator, expected));
  return results.reduce(["does not equal", "does not contain"].includes(rule.operator ?? "") ? and : or, ["does not equal", "does not contain"].includes(rule.operator ?? ""));
}

function matchesObservedTouchQuery(history: [string, string] | undefined, rule: RuleObject): Truth {
  const value = history?.[rule.occurrence === "first touch" ? 0 : 1];
  return value === undefined ? UNKNOWN : matchesQueryValue(value, rule);
}

export function decide(plan: EdgePlan, request: EdgeRequest, touch: TouchState, now: EvaluationTime = new Date()): Decision[] {
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);
  const context = decodeContextCookie(request.headers.get("cookie") || "");
  const hard = context.dims && typeof context.dims === "object" ? context.dims : {};
  const identityScopeMatches = !context.identityScope || String(context.identityScope.project) === String(plan.teamPid);
  const hasIntegrationIdentity = identityScopeMatches && context.cid != null && String(context.cid) !== "";
  // The plan names the active ESP connection; a snapshot from a replaced connection is ignored,
  // just as the browser rejects that identity.
  const recordedOutcomes = hasIntegrationIdentity && context.identityScope && typeof plan.connectionScope === "string" && context.identityScope.connection === plan.connectionScope
    ? decodeEdgeSignals(context.es, { project: String(context.identityScope.project), connection: plan.connectionScope, contactId: String(context.cid), origin: url.origin, today: Math.floor(new Date(now).getTime() / 86400000) })
    : null;
  let clock: LocalClock | null | undefined;
  const dateClock = () => {
    if (clock === undefined) clock = createLocalClock(now, request.cf?.timezone);
    return clock;
  };
  const dimensions = new Map(plan.dimensions.map(d => [d.id, d]));
  const bySegment = new Map(plan.dimensions.flatMap(d => d.segments.map(s => [s.id, d.id])));
  const cache = new Map<string, Record<string, Truth>>();
  const active = new Set<string>();
  const dimension = (id: string | undefined): Record<string, Truth> => {
    if (id === undefined) return {};
    if (cache.has(id)) return cache.get(id)!;
    const d = dimensions.get(id);
    if (!d) return {};
    if (active.has(id)) return Object.fromEntries(d.segments.map(s => [s.id, UNKNOWN]));
    active.add(id);
    const result: Record<string, Truth> = {};
    const possible = new Set<string>();
    let remaining = true;
    for (const priority of ["answer", "signal"]) {
      for (const s of d.segments) {
        if (result[s.id] === true) continue;
        let match: Truth = false;
        if (d.isMultiWinning || remaining) {
          // The tag writes every answer to _rm_ctx before navigation, so a
          // dimension missing from it (or no _rm_ctx at all) is unanswered.
          match = priority === "answer"
            ? Array.isArray(hard[d.id]) && (hard[d.id] as unknown[]).includes(s.id)
            : (d.signals || []).filter(signal => signal.indicates === s.id).reduce<Truth>((value, signal) => or(value, evaluateRule(signal.definition)), false);
        }
        if (d.isMultiWinning) result[s.id] = or(result[s.id] || false, match);
        else if (remaining && match !== false) {
          possible.add(s.id);
          if (match === true) remaining = false;
        }
      }
    }
    if (!d.isMultiWinning) for (const s of d.segments) result[s.id] = !possible.has(s.id) ? false : !remaining && possible.size === 1 ? true : UNKNOWN;
    active.delete(id);
    cache.set(id, result);
    return result;
  };
  const segment = (id: string): Truth => {
    const value = dimension(bySegment.get(id))[id];
    return value === undefined ? false : value;
  };
  const evaluateRule = (rule: Rule | undefined): Truth => {
    if (!rule || typeof rule !== "object") return typeof rule === "boolean" ? rule : false;
    for (const operator of ["and", "all"] as const) {
      if (Array.isArray(rule[operator])) return rule[operator].length ? rule[operator].reduce<Truth>((result, part) => and(result, evaluateRule(part)), true) : false;
    }
    for (const operator of ["or", "any"] as const) {
      if (Array.isArray(rule[operator])) return rule[operator].length ? rule[operator].reduce<Truth>((result, part) => or(result, evaluateRule(part)), false) : false;
    }
    if (Object.hasOwn(rule, "not")) { const value = evaluateRule(rule.not); return value === UNKNOWN ? UNKNOWN : !value; }
    if (rule.edge?.supported === false) {
      if (hasIntegrationIdentity) {
        // The tag's last outcome for this contact (integration profile or landing page);
        // a rule it never recorded, or one a republish re-keyed, stays unknown, never false.
        const recorded = typeof rule.edge.key === "string" ? recordedOutcomes?.get(rule.edge.key) : undefined;
        return typeof recorded === "boolean" ? recorded : UNKNOWN;
      }
      return rule.edge.reason === "integration-signal" ? evaluateAnonymousIntegrationRule(rule) : UNKNOWN;
    }
    switch (rule.$source) {
      case "segments": {
        const results = dimension(rule.$type);
        const known = Object.keys(results).filter(id => results[id] === true);
        const possible = Object.keys(results).filter(id => results[id] !== false);
        const lower = compare(known, rule.operator, rule.segmentId, "array");
        const upper = compare(possible, rule.operator, rule.segmentId, "array");
        return lower === upper ? lower : UNKNOWN;
      }
      case "utm": return evaluateRule({ ...rule, $source: "query", query: rule.$type });
      case "query": return evaluateRule({ ...rule, $source: "pageviews", $type: "query" });
      case "currentpage": return rule.$type === "path" ? compare(url.pathname, rule.operator, rule.value, "path") : UNKNOWN;
      case "pageviews": {
        if (rule.timeframe && rule.timeframe !== "ever") return UNKNOWN;
        if (rule.$type === "query") {
          if (rule.occurrence === "first touch" || rule.occurrence === "last touch") {
            // Both cookie writers record every observed name and the tag seeds
            // pre-cookie history, so an unobserved name has no pageview: the
            // browser evaluates that as false for every operator.
            if (!Object.hasOwn(touch.q, String(rule.query))) return false;
            return matchesObservedTouchQuery(touch.q[String(rule.query)], rule);
          }
          if (rule.occurrence !== "last" && rule.occurrence !== "current") return UNKNOWN;
          return matchesQueryValue(Object.hasOwn(query, String(rule.query)) ? query[String(rule.query)] : undefined, rule);
        }
        if (rule.$type === "path" && ["last", "current"].includes(rule.occurrence ?? "")) {
          let expected = rule.value;
          if (typeof expected !== "string") return false;
          if (/^https?:\/\//.test(expected) || /^[^/]+\.[^/]+/.test(expected)) {
            try {
              const criterion = new URL(/^https?:\/\//.test(expected) ? expected : `https://${expected}`);
              if (criterion.hostname !== url.hostname) return false;
              if (criterion.pathname === "/" && !expected.endsWith("/")) return true;
              expected = criterion.pathname;
            } catch {}
          }
          return compare(url.pathname, rule.operator, expected, "path");
        }
        return UNKNOWN;
      }
      case "referrer": {
        if (!Object.hasOwn(touch, "r")) return UNKNOWN;
        const hostname = touch.r;
        if (rule.$type === "direct") return !hostname;
        if (rule.$type === "referral") return !!hostname;
        if (rule.$type === "domain") return (rule.domain || "").split(",").map(x => x.trim()).filter(Boolean).some(pattern => hostnameMatchesDomain(hostname, pattern));
        return UNKNOWN; // The touch contract deliberately does not retain URL paths.
      }
      case "location": {
        if (!request.cf) return UNKNOWN;
        if (rule.$type === "country") return compare(rule.value, rule.operator, [request.cf.country], "array");
        if (rule.$type === "city") return compare(request.cf.city, rule.operator, rule.value);
        return UNKNOWN;
      }
      case "date": {
        const local = dateClock();
        return local ? evaluateDateRule(rule, local) : UNKNOWN;
      }
      case "device": {
        const ua = request.headers.get("user-agent") || "";
        if (rule.$type === "browser") return (rule.browsers || []).some(browser => ua.includes(browser));
        if (rule.$type === "os") {
          const patterns: Record<string, RegExp> = { iOS: /iPad|iPhone|iPod/, Android: /Android/, MacOS: /Macintosh|MacIntel|MacPPC|Mac68K/, Windows: /Win32|Win64|Windows|WinCE/, Linux: /Linux/ };
          return (rule.operatingSystems || []).some(os => patterns[os]?.test(ua));
        }
        return UNKNOWN;
      }
      default: return UNKNOWN;
    }
  };
  const rulesMatch = (rules: Rule | undefined): Truth => {
    if (!rules) return false;
    if (typeof rules === "object" && Array.isArray(rules.all)) return rules.all.reduce<Truth>((value, rule) => and(value, typeof rule === "object" && rule.segment ? segment(rule.segment) : evaluateRule(rule)), true);
    if (typeof rules === "object" && Array.isArray(rules.any)) return rules.any.length ? rules.any.reduce<Truth>((value, rule) => or(value, typeof rule === "object" && rule.segment ? segment(rule.segment) : evaluateRule(rule)), false) : true;
    return evaluateRule(rules);
  };
  const matchesPage = (page: PageCriterion[] | undefined): boolean => Array.isArray(page) && page.some(criterion => {
    const host = (hostname: string) => hostname.replace(/^www\./, "");
    if (criterion.domain !== "*" && host(criterion.domain || "") !== host(url.hostname)) return false;
    const normalize = (path: string) => path.replace(/^\/+|\/+$/g, "").toLowerCase();
    const path = normalize(criterion.path || "");
    return path.includes("*") ? new RegExp(`^${path.replace("*", ".*")}$`).test(normalize(url.pathname)) : path === normalize(url.pathname);
  });
  // Arms follow the browser: a recorded arm (mirrored in `_rm_ctx.ca`) wins, then the shared
  // holdout hash of the visitor unit. The holdout arm and an unknown arm leave the campaign to the
  // browser, which keeps the original content for the holdout and records both arms' exposures.
  // A debugger request always takes the treatment arm, as the browser does.
  const forceTreatment = debugForcesTreatment(url);
  const arms = decodeCampaignArms(context);
  const unit = holdoutUnit(touch.u, context);
  const decisions: Decision[] = [];
  for (const campaign of plan.campaigns) {
    if (!campaign.is_active || (!forceTreatment && campaignHoldback(campaign, arms, unit) !== false)) continue;
    for (const variant of campaign.variants || []) {
      if (rulesMatch(variant.rules) !== true) continue;
      const actions: Action[] = [];
      for (const action of variant.actions || []) {
        // `campaign-experiment` operations run only once the treatment arm is assigned above.
        const executable = action.edge?.supported === true || (action.edge?.reason === "campaign-experiment" && (action.edge.operations?.length ?? 0) > 0);
        if (executable && matchesPage(action.page)) actions.push(action);
      }
      if (actions.length) decisions.push({ campaignId: campaign.id, variantId: variant.id, actions });
    }
  }
  return decisions;
}

/** Flatten matched variants in published campaign, variant, then action order. */
export function evaluatePlan(plan: EdgePlan, request: EdgeRequest, touch: TouchState, now: EvaluationTime = new Date()): Action[] {
  return decide(plan, request, touch, now).flatMap(decision => decision.actions);
}
