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
export interface Action {
  id?: string;
  actionId: string;
  campaignId: string;
  variantId: string;
  type?: string;
  page?: PageCriterion[];
  selector: string;
  modifications?: Modifications;
  edge: EdgeSupport;
  [key: string]: unknown;
}
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
  actions?: Action[];
  [key: string]: unknown;
}
export interface Campaign {
  id: string;
  is_active?: boolean;
  variants?: Variant[];
  [key: string]: unknown;
}
export interface EdgePlan {
  version: 1;
  teamPid: string;
  connectionScope?: string;
  queryNames: string[];
  dimensions: Dimension[];
  campaigns: Campaign[];
  [key: string]: unknown;
}
export interface Decision { campaignId: string; variantId: string; actions: Action[] }
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
