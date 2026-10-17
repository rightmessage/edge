import type { EdgeSupport, Slot } from "./plan-types.js";

/** The slot family an operation token writes. Unknown tokens may write anything on the element. */
export function operationSlot(token: string): Slot {
  if (token === "text" || token === "findReplace") return "children";
  if (token === "attr:style" || token.startsWith("style:") || token === "visibility") return "style";
  if (token === "attr:class" || token === "classes") return "class";
  if (token.startsWith("attr:") && token.length > 5) return token as Slot;
  return "element";
}

const CLAIM_FAMILIES: Record<string, true> = { children: true, style: true, class: true, element: true, page: true };
const claimSlot = (claim: unknown): Slot => typeof claim !== "string" ? "element" : Object.hasOwn(CLAIM_FAMILIES, claim) ? claim as Slot : claim.startsWith("attr:") ? operationSlot(claim) : "element";
const tokens = (value: unknown): string[] => Array.isArray(value) ? value.filter((token): token is string => typeof token === "string") : [];

/** Every slot a writer the edge does not perform may touch: its operations, deferred operations and claims. */
export function heldSlots(edge: EdgeSupport | undefined): Slot[] {
  const slots = new Set<Slot>();
  for (const token of [...tokens(edge?.operations), ...tokens(edge?.deferredOperations)]) slots.add(operationSlot(token));
  if (Array.isArray(edge?.claims)) for (const claim of edge.claims) slots.add(claimSlot(claim));
  return [...slots];
}

/** True when two slot sets can touch the same state on one element. */
export function slotsIntersect(a: readonly Slot[], b: readonly Slot[]): boolean {
  if (a.includes("element") && b.length) return true;
  if (b.includes("element") && a.length) return true;
  return a.some(slot => b.includes(slot));
}
