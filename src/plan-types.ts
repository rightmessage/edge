/** Published plans retain browser-only rules and operations for the browser to finish. */
export interface EdgeSupport {
  supported: boolean;
  reason?: string | null;
  key?: string;
  operations?: string[];
  deferredOperations?: string[];
  [key: string]: unknown;
}

export type Rule = boolean | RuleObject;
export interface RuleObject {
  $source?: string;
  $type?: string;
  operator?: string;
  value?: unknown;
  and?: Rule[];
  all?: Rule[];
  or?: Rule[];
  any?: Rule[];
  not?: Rule;
  segment?: string;
  segmentId?: unknown;
  query?: string;
  occurrence?: string;
  timeframe?: string;
  domain?: string;
  browsers?: string[];
  operatingSystems?: string[];
  tagIds?: unknown;
  listIds?: unknown;
  productIds?: unknown;
  count?: string | number;
  dateEnd?: string | number;
  edge?: EdgeSupport;
  [key: string]: unknown;
}

export interface PageCriterion { domain?: string; path?: string }
export interface FindReplace { find: string; replace?: string }
export interface Modifications {
  text?: unknown;
  findReplace?: FindReplace[];
  attr?: Record<string, unknown>;
  style?: Record<string, unknown>;
  classes?: { add?: string[]; remove?: string[] };
  visibility?: string;
  [key: string]: unknown;
}
export type VersionId = "A" | "B" | "C" | "D";
/** The node id and `variantId` of a campaign's Original layer. */
export const ORIGINAL_ID = "original";

/** Weights are integers 1..99 summing to 100 over a subset of A..D that includes A. Anything else parses as invalid. */
export type PlanAbTest =
  | { id: string; state: "running"; run: string; weights: Partial<Record<VersionId, number>> }
  | { id: string; state: "setup" };

/** Wire slot families. `page` means the edge cannot locate the writer's elements. */
export type Slot = "children" | "style" | "class" | "element" | "page" | `attr:${string}`;

export interface Action {
  id?: string;
  actionId: string;
  campaignId: string;
  variantId: string;
  type?: string;
  page?: PageCriterion[];
  selector: string;
  modifications?: Modifications;
  /** Present only on a form that occurs in some, not all, versions of a running test. */
  versions?: VersionId[];
  edge: EdgeSupport;
  [key: string]: unknown;
}
/** A write the browser owns. It is shipped so the edge can stay beneath it. */
export interface BrowserOwnedAction {
  actionId: string;
  campaignId: string;
  variantId: string;
  page?: PageCriterion[];
  selector?: string;
  versions?: VersionId[];
  edge: { supported: false; reason: "browser-owned"; operations: []; claims: Slot[]; [key: string]: unknown };
  [key: string]: unknown;
}
export type PlanEntry = Action | BrowserOwnedAction;
export interface Segment { id: string; [key: string]: unknown }
export interface Signal {
  indicates: string;
  definition: Rule;
  edge?: EdgeSupport;
  [key: string]: unknown;
}
export interface Dimension {
  id: string;
  isMultiWinning?: boolean;
  segments: Segment[];
  signals?: Signal[];
  [key: string]: unknown;
}
export interface Variant {
  id: string;
  rules?: Rule;
  abTest?: PlanAbTest;
  actions?: PlanEntry[];
  [key: string]: unknown;
}
/** Without `abTest` the layer is a deployed winner. */
export interface OriginalLayer { abTest?: PlanAbTest; actions?: PlanEntry[] }
export interface Campaign {
  id: string;
  is_active?: boolean;
  original?: OriginalLayer;
  variants?: Variant[];
  [key: string]: unknown;
}
export interface EdgePlan {
  /** `2` exactly when `consent` is `"required"`. */
  version: 1 | 2;
  consent?: "required";
  teamPid: string;
  connectionScope?: string;
  queryNames: string[];
  dimensions: Dimension[];
  campaigns: Campaign[];
  [key: string]: unknown;
}
/** Evaluator output in browser candidate order: the array index is the layer rank. */
export type Step =
  | { kind: "apply"; action: Action; versions?: VersionId[] }
  | { kind: "claim"; selector: string; slots: Exclude<Slot, "page">[] }
  | { kind: "cut" };
export interface Decision {
  campaignId: string;
  variantId: string;
  layer: "original" | "audience";
  /** The drawn version of a running test. */
  versionId?: VersionId;
  actions: Action[];
}
/** Request facts supplied by an edge adapter; absent facts stay unknown. */
export interface EdgeRequest extends Request {
  cf?: { timezone?: string; country?: string; city?: string; [key: string]: unknown };
}
export type EvaluationTime = Date | string | number;
export interface Release {
  version: number;
  teamPid: string;
  revision: string;
  planUrl: string;
  loaderUrl: string;
}
