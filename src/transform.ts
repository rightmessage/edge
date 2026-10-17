import { decodeHTML, decodeHTMLAttribute, escapeAttribute } from "entities";
import { boundedBytes, OUTPUT_CAP } from "./bytes.js";
import type { Action, Release, Slot, Step, VersionId } from "./plan-types.js";
import { operationSlot, slotsIntersect } from "./slots.js";
import type { HTMLRewriterConstructor, HTMLRewriterInstance, RewriterElement, RewriterElementHandlers } from "./rewriter-types.js";

const TARGET = "data-rm-edge-target";
const nonempty = (value: unknown) => value !== "" && value !== null && value !== undefined;
const readAttribute = (element: RewriterElement, name: string) => {
  const raw = element.getAttribute(name);
  return raw === null ? null : decodeHTMLAttribute(raw);
};
const encodeJSON = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

type Modifications = ReturnType<typeof declaredModifications>;
type Rewrite = (bytes: Uint8Array<ArrayBuffer>, rewriter: HTMLRewriterInstance) => Promise<Uint8Array<ArrayBuffer>>;
interface Declaration { name: string; value: string; important: boolean }
interface TextBaseline { index: number; text: string }
interface Target {
  attributes: Record<string, string>;
  textNodes: TextBaseline[];
  text: string | null;
  findReplace: boolean;
  containsRegion: boolean;
  emptiedNode: boolean;
  void: boolean;
}
interface Pair {
  action: Action;
  index: number;
  id: string;
  applied: Set<string>;
  changed: boolean;
  emptied: boolean;
  attributes: Set<string>;
}
export interface Original {
  attributes: Record<string, string | null>;
  textNodes: TextBaseline[];
  html?: string | null;
}
export interface Receipt {
  campaignId: string;
  variantId: string;
  actionId: string;
  targetId: string;
  operations: string[];
  /** The versions of a running test whose form this was; absent on untested and version-independent actions. */
  versions?: VersionId[];
}

// Minimal inline-style editing: declarations are kept in order and only the edited property is
// replaced or appended. Shapes this cannot reproduce exactly (comments, duplicates, related
// shorthand/longhand families, unsafe values) return null and stay browser-owned.
const STYLE_FAMILIES = [["inset", "top", "right", "bottom", "left"], ["gap", "row-gap", "column-gap", "grid-gap"], ["place", "align", "justify"], ["font", "line-height"], ["columns", "column"]];
const styleFamily = (name: string): string => {
  if (name.startsWith("--")) return name;
  for (const group of STYLE_FAMILIES) if (group.some(member => name === member || name.startsWith(`${member}-`))) return group[0];
  return name.split("-")[name.startsWith("-") ? 1 : 0];
};

function parseDeclarations(cssText: string): Declaration[] | null {
  if (cssText.includes("/*")) return null;
  const parts = [];
  let depth = 0, quote = "", start = 0;
  for (let index = 0; index < cssText.length; index++) {
    const character = cssText[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth++;
    else if (character === ")" && --depth < 0) return null;
    else if (character === ";" && depth === 0) {
      parts.push(cssText.slice(start, index));
      start = index + 1;
    }
  }
  if (quote || depth) return null;
  parts.push(cssText.slice(start));
  const declarations: Declaration[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    const colon = part.indexOf(":");
    if (colon <= 0) return null;
    let name = part.slice(0, colon).trim();
    if (!/^(--[\w-]+|-?[a-zA-Z][\w-]*)$/.test(name)) return null;
    if (!name.startsWith("--")) name = name.toLowerCase();
    let value = part.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, "").trim();
    if (!value || value.includes("!")) return null;
    declarations.push({ name, value, important });
  }
  return new Set(declarations.map(declaration => declaration.name)).size === declarations.length ? declarations : null;
}

// Returns "changed", "same", or null when the edit is unsupported at the edge.
function assignStyle(declarations: Declaration[], property: string, rawValue: unknown) {
  const name = String(property).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  const value = String(rawValue).trim();
  if (!/^-?[a-z][a-z0-9-]*$/.test(name) || !value || !/^[^;{}!\\<>"'\n\r]*$/.test(value)) return null;
  let depth = 0;
  for (const character of value) if ((depth += character === "(" ? 1 : character === ")" ? -1 : 0) < 0) return null;
  if (depth) return null;
  const family = styleFamily(name);
  if (declarations.some(declaration => declaration.name !== name && styleFamily(declaration.name) === family)) return null;
  const index = declarations.findIndex(declaration => declaration.name === name);
  if (index !== -1 && declarations[index].value === value && !declarations[index].important) return "same";
  const next = { name, value, important: false };
  if (index === -1) declarations.push(next);
  else declarations[index] = next;
  return "changed";
}

const serializeDeclarations = (declarations: Declaration[]) => declarations.map(({ name, value, important }) => `${name}: ${value}${important ? " !important" : ""};`).join(" ");

function replacementRegex(pattern: string) {
  const match = pattern.match(/^\/(.+)\/([gimsuvy]*)$/);
  if (match) { try { return new RegExp(match[1], match[2] || "g"); } catch {} }
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
}

// Browser ordering is replacement-major within an action; RegExp state is reset per node,
// so applying an action's replacements to one node at a time is equivalent.
function replaceText(value: string, replacements: NonNullable<Modifications["findReplace"]>) {
  for (const { find, replace } of replacements) {
    if (!find) continue;
    const regex = replacementRegex(find);
    if (value && regex.test(value)) {
      regex.lastIndex = 0;
      value = value.replace(regex, replace || "");
    }
  }
  return value;
}

const RAW_TEXT_TAGS = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
const RAW_TEXT_SELECTOR = [...RAW_TEXT_TAGS].join(",");
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);

// element.onEndTag replaces any earlier end-tag handler for the same element, so every target's
// close callbacks are collected here and installed once by a handler registered after all
// target handlers. A raw-text target folds in the raw-text tracker's reset it replaced.
// Elements without an end tag run their callbacks immediately.
function createCloser(raw: ReturnType<typeof rawTextContext>) {
  let callbacks: Array<() => void> = [];
  const selectors = new Set<string>();
  return {
    watch(selector: string) { selectors.add(selector); },
    onClose(callback: () => void) { callbacks.push(callback); },
    install(rewriter: HTMLRewriterInstance, beforeClose: (element: RewriterElement) => void = () => {}) {
      if (!selectors.size) return;
      rewriter.on([...selectors].join(","), { element(element) {
        beforeClose(element);
        const pending = callbacks.reverse();
        callbacks = [];
        if (!pending.length) return;
        if (raw?.owns(element)) pending.push(raw.reset);
        const run = () => { for (const callback of pending) callback(); };
        try { element.onEndTag(run); } catch { run(); }
      } });
    },
  };
}

// Tracks the enclosing raw-text element, whose text is Text.data rather than HTML. It installs
// its own end-tag handler so ordinary scripts never pass through the target closer.
function rawTextContext(rewriter: HTMLRewriterInstance) {
  let tag = "";
  const owns = (element: RewriterElement) => RAW_TEXT_TAGS.has(element.tagName) && element.namespaceURI === "http://www.w3.org/1999/xhtml";
  const reset = () => { tag = ""; };
  rewriter.on(RAW_TEXT_SELECTOR, { element(element) {
    if (!owns(element)) return;
    tag = element.tagName;
    element.onEndTag(reset);
  } });
  return { current: () => tag, owns, reset };
}

// Declared, edge-supported modifications of one action.
function declaredModifications(action: Action) {
  const declared = new Set(action.edge.operations || []);
  const source = action.modifications || {};
  const findReplace = declared.has("findReplace") && source.findReplace?.length ? source.findReplace : null;
  return {
    findReplace,
    text: !findReplace && declared.has("text") && nonempty(source.text) ? String(source.text) : null,
    attr: Object.entries(source.attr || {}).filter(([name, value]) => declared.has(`attr:${name}`) && nonempty(value)),
    style: Object.entries(source.style || {}).filter(([name, value]) => declared.has(`style:${name}`) && nonempty(value)),
    classes: declared.has("classes") ? source.classes : null,
    hide: declared.has("visibility") && source.visibility === "hide",
  };
}

// Selectors are matched once against the original document. An apply whose selector reads an
// attribute that an earlier step writes could match differently in the browser's sequential
// application, so it stays browser-owned. A cut or an `element` claim may write any attribute.
function edgeApplicable(steps: readonly Step[], modifications: Modifications[]) {
  const written = new Set<string>();
  let writesAny = false;
  const applicable: boolean[] = [];
  for (const step of steps) {
    if (step.kind === "cut") { writesAny = true; continue; }
    if (step.kind === "claim") {
      for (const slot of step.slots) {
        if (slot === "element") writesAny = true;
        else if (slot === "class" || slot === "style") written.add(slot);
        else if (slot.startsWith("attr:")) written.add(slot.slice(5).toLowerCase());
      }
      continue;
    }
    const selector = step.action.selector.toLowerCase();
    const reads = (name: string) => (name === "class" && /\.[a-z_-]/i.test(selector)) || (name === "id" && selector.includes("#")) || new RegExp(`\\[\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(selector);
    applicable.push(!(writesAny && /[.#[]/.test(selector)) && ![...written].some(reads));
    const mods = modifications[applicable.length - 1];
    for (const [name] of mods.attr) written.add(name.toLowerCase());
    if (mods.style.length || mods.hide) written.add("style");
    if (mods.classes) written.add("class");
  }
  return applicable;
}

/** The applies of a step list and what every pass needs to identify their targets identically. */
interface Layout {
  actions: Action[];
  modifications: Modifications[];
  /** Selector-safe and not beneath a cut. */
  applicable: boolean[];
  /** `index:match` pairs the probe left to the browser; `match` counts elements matched by any applicable selector. */
  vetoed: Set<string>;
}
/** A higher writer the edge does not perform: a claim step, or an apply's own deferred operations. */
interface Hold { rank: number; selector: string; slots: readonly Slot[] }
interface ProbeElement { match: number; applies: number[]; holds: number[]; ancestors: ProbeElement[] }

// One read-only pass over the original bytes. Apply i on element E is vetoed when a hold of a
// higher rank matches E with an intersecting slot family, matches an ancestor of E and claims
// its children or the whole element, or matches a descendant of E while i writes E's children.
// Only lower ranks are vetoed: the browser marks a slot unknown only for candidates beneath a
// later undecided writer. Text and find/replace on one target are both left to the browser.
async function probeVetoes(bytes: Uint8Array<ArrayBuffer>, layout: Omit<Layout, "vetoed">, ranks: number[], holds: Hold[], Rewriter: HTMLRewriterConstructor, rewrite: Rewrite) {
  const { actions, modifications, applicable } = layout;
  const selectors = actions.flatMap((action, index) => applicable[index] ? [action.selector] : []);
  const vetoed = new Set<string>();
  if (!selectors.length) return vetoed;
  const probe = new Rewriter();
  const elements: ProbeElement[] = [];
  const open: ProbeElement[] = [];
  let current: ProbeElement | null = null;
  let match = 0;
  probe.on([...selectors, ...holds.map(hold => hold.selector)].join(","), { element(element) {
    const record: ProbeElement = { match: 0, applies: [], holds: [], ancestors: [...open] };
    current = record;
    elements.push(record);
    open.push(record);
    // An element whose end tag is implied stays open, so it over-approximates later ancestry: more vetoes, never fewer.
    try { element.onEndTag(() => { open.splice(open.lastIndexOf(record), 1); }); } catch { open.pop(); }
  } });
  probe.on(selectors.join(","), { element() { if (current) current.match = ++match; } });
  actions.forEach((action, index) => {
    if (applicable[index]) probe.on(action.selector, { element() { current?.applies.push(index); } });
  });
  holds.forEach((hold, index) => probe.on(hold.selector, { element() { current?.holds.push(index); } }));
  await rewrite(bytes, probe);

  const nested = new Map<ProbeElement, number[]>();
  for (const element of elements) {
    for (const ancestor of element.ancestors) nested.set(ancestor, [...(nested.get(ancestor) ?? []), ...element.holds]);
  }
  for (const element of elements) {
    if (!element.applies.length) continue;
    const inherited = element.ancestors.flatMap(ancestor => ancestor.holds).filter(index => holds[index].slots.includes("children") || holds[index].slots.includes("element"));
    const descendants = nested.get(element) ?? [];
    const kept: number[] = [];
    for (const index of element.applies) {
      const slots = [...new Set((actions[index].edge.operations || []).map(operationSlot))];
      const higher = (hold: number) => holds[hold].rank > ranks[index];
      const blocked = element.holds.some(hold => higher(hold) && slotsIntersect(holds[hold].slots, slots))
        || inherited.some(higher)
        || (slots.includes("children") && descendants.some(higher));
      if (blocked) vetoed.add(`${index}:${element.match}`);
      else kept.push(index);
    }
    const content = kept.filter(index => modifications[index].text !== null || modifications[index].findReplace);
    if (content.some(index => modifications[index].text !== null) && content.some(index => modifications[index].findReplace)) {
      for (const index of content) vetoed.add(`${index}:${element.match}`);
    }
  }
  return vetoed;
}

// Identifies targets identically in every pass: ids follow first-match document order over the
// pairs that apply, and content inside a target whose children are replaced by `text` is never
// personalized.
function registerTargets(rewriter: HTMLRewriterInstance, closer: ReturnType<typeof createCloser>, layout: Layout, onTarget: (element: RewriterElement, id: string, index: number, first: boolean) => boolean, onText: (index: number) => RewriterElementHandlers["text"] | null = () => null) {
  const { actions, applicable, vetoed } = layout;
  const regions: string[] = [];
  let nextId = 0;
  let current: string | null = null;
  let match = 0;
  const selectors = actions.flatMap((action, index) => applicable[index] ? [action.selector] : []);
  if (!selectors.length) return () => false;
  // Counts matches exactly as the probe does, so a vetoed pair names the same element in every pass.
  rewriter.on(selectors.join(","), { element() { match++; } });
  actions.forEach((action, index) => {
    if (!applicable[index]) return;
    closer.watch(action.selector);
    const handlers: RewriterElementHandlers = { element(element) {
      if (vetoed.has(`${index}:${match}`)) return;
      let id = element.getAttribute(TARGET);
      if (regions.length && (id === null || regions.at(-1) !== id)) return;
      let first = false;
      if (id === null) {
        id = current = `e${++nextId}`;
        first = true;
      } else if (id !== current) {
        // Handlers for one element run consecutively; any other identity came from the origin.
        throw new Error("Preexisting edge identity");
      }
      const region = onTarget(element, id, index, first);
      if (region && !regions.includes(id)) {
        regions.push(id);
        closer.onClose(() => regions.pop());
      }
    } };
    const text = onText(index);
    if (text) handlers.text = text;
    rewriter.on(action.selector, handlers);
  });
  return () => regions.length > 0;
}

async function captureOriginalHTML(bytes: Uint8Array<ArrayBuffer>, layout: Layout, ids: Set<string>, Rewriter: HTMLRewriterConstructor, rewrite: Rewrite) {
  const nonce = crypto.randomUUID();
  const capture = new Rewriter();
  const raw = rawTextContext(capture);
  const closer = createCloser(raw);
  registerTargets(capture, closer, layout, (element, id, index, first) => {
    if (first) {
      element.setAttribute(TARGET, id);
      if (ids.has(id)) {
        element.prepend(`<!--rm-${nonce}-${id}-s-->`, { html: true });
        element.append(`<!--rm-${nonce}-${id}-e-->`, { html: true });
      }
    }
    return !!layout.modifications[index].text;
  });
  // Runs after every target handler for the element, so identification never reaches output.
  closer.install(capture, element => element.removeAttribute(TARGET));
  const captured = new TextDecoder("utf-8", { fatal: true }).decode(await rewrite(bytes, capture));
  const html = new Map<string, string>();
  for (const id of ids) {
    const begin = `<!--rm-${nonce}-${id}-s-->`, end = `<!--rm-${nonce}-${id}-e-->`;
    const start = captured.indexOf(begin), finish = captured.indexOf(end);
    if (start === -1 || finish < start) throw new Error("Missing original children");
    html.set(id, captured.slice(start + begin.length, finish).replace(new RegExp(`<!--rm-${nonce}-e\\d+-[se]-->`, "g"), ""));
  }
  return html;
}

// Text and find/replace on one target cannot both be reproduced in one streaming pass. Only the
// probe can tell that two selectors name one element, so the first pass is optimistic.
const CONTENT_CONFLICT = "Text and find/replace on one target";

export async function transformHTML(bytes: Uint8Array<ArrayBuffer>, steps: readonly Step[], release: Release, Rewriter: HTMLRewriterConstructor): Promise<Uint8Array<ArrayBuffer> | null> {
  const rewrite: Rewrite = async (input, rewriter) => boundedBytes(rewriter.transform(new Response(input, { headers: { "content-type": "text/html; charset=utf-8" } })), OUTPUT_CAP);
  const actions: Action[] = [];
  const ranks: number[] = [];
  const versions: (VersionId[] | undefined)[] = [];
  const holds: Hold[] = [];
  let lastCut = -1;
  steps.forEach((step, rank) => {
    if (step.kind === "cut") lastCut = rank;
    else if (step.kind === "claim") holds.push({ rank, selector: step.selector, slots: step.slots });
    else {
      actions.push(step.action);
      ranks.push(rank);
      versions.push(step.versions);
      const deferred = (step.action.edge.deferredOperations || []).map(operationSlot);
      if (deferred.length) holds.push({ rank, selector: step.action.selector, slots: [...new Set(deferred)] });
    }
  });
  const modifications = actions.map(declaredModifications);
  // A cut is a writer the edge cannot locate: every lower apply stays with the browser.
  const applicable = edgeApplicable(steps, modifications).map((safe, index) => safe && ranks[index] > lastCut);
  const lowest = ranks.find((_rank, index) => applicable[index]) ?? Infinity;
  const probe = () => probeVetoes(bytes, { actions, modifications, applicable }, ranks, holds, Rewriter, rewrite);
  const probed = holds.some(hold => hold.rank > lowest);
  const layout: Layout = { actions, modifications, applicable, vetoed: probed ? await probe() : new Set() };
  try {
    return await rewriteDocument(bytes, layout, versions, release, Rewriter, rewrite);
  } catch (error) {
    if (probed || !(error instanceof Error) || error.message !== CONTENT_CONFLICT) throw error;
    return rewriteDocument(bytes, { ...layout, vetoed: await probe() }, versions, release, Rewriter, rewrite);
  }
}

// One rewriting pass applies every action. Text-node replacements, receipts and success stamps
// are resolved as the stream completes, then committed by exact substitutions in the buffered
// output; a capture pass over the original bytes runs only when a find/replace empties a text
// node, the one case that needs original inner HTML the rewritten stream cannot provide.
async function rewriteDocument(bytes: Uint8Array<ArrayBuffer>, layout: Layout, versions: (VersionId[] | undefined)[], release: Release, Rewriter: HTMLRewriterConstructor, rewrite: Rewrite): Promise<Uint8Array<ArrayBuffer> | null> {
  const { actions, modifications } = layout;
  const encoder = new TextEncoder();
  let baselineBytes = 0;
  const reserveBaseline = (value: string) => {
    baselineBytes += encoder.encode(value).byteLength;
    if (baselineBytes > OUTPUT_CAP) throw new Error("Personalization baseline limit");
  };
  const nonce = crypto.randomUUID();
  const stamp = `data-rm-stamp-${nonce}`;
  const targets = new Map<string, Target>();
  const pairs: Pair[] = [];
  const pairsByAction = actions.map(() => new Map<string, Pair>());
  const openTargets: string[] = [];
  const openByAction = actions.map((): string[] => []);
  let pending: { source: string; actions: Set<number> } | null = null;

  const rewriter = new Rewriter();
  const raw = rawTextContext(rewriter);
  const closer = createCloser(raw);
  let heads = 0;
  const headPlaceholder = `<!--rm-${nonce}-receipt-->`;
  rewriter.on("#RM_EDGE", { element() { throw new Error("Preexisting edge receipt"); } });
  rewriter.on("head", { element(element) {
    if (++heads === 1) element.prepend(headPlaceholder, { html: true });
  } });
  // Per-action text handlers collect, for each chunk, the find/replace actions whose open targets
  // contain it. A union-selector handler registered after them runs once per chunk (even for
  // nested matches) and owns the node; text outside find/replace targets never reaches JS.
  const textSelectors: string[] = [];
  const collectText = (index: number) => {
    if (!modifications[index].findReplace) return null;
    textSelectors.push(actions[index].selector);
    return () => {
      if (openByAction[index].length) (pending ||= { source: "", actions: new Set() }).actions.add(index);
    };
  };
  const insideRegion = registerTargets(rewriter, closer, layout, (element, id, index, first) => {
    const action = actions[index];
    const mods = modifications[index];
    let target = targets.get(id)!;
    if (first) {
      if (element.hasAttribute("data-rm-personalized") || element.hasAttribute("data-rm-variant")) throw new Error("Preexisting personalization stamp");
      const attributes = Object.fromEntries(Array.from(element.attributes, ([name, value]) => [name, decodeHTMLAttribute(value)]));
      reserveBaseline(JSON.stringify(attributes));
      target = { attributes, textNodes: [], text: null, findReplace: false, containsRegion: false, emptiedNode: false, void: VOID_ELEMENTS.has(element.tagName) };
      targets.set(id, target);
      element.setAttribute(TARGET, id);
      element.setAttribute(stamp, id);
      openTargets.push(id);
      closer.onClose(() => openTargets.splice(openTargets.lastIndexOf(id), 1));
    }
    const pair: Pair = { action, index, id, applied: new Set(), changed: false, emptied: false, attributes: new Set() };
    pairs.push(pair);
    pairsByAction[index].set(id, pair);
    const attribute = (name: string) => pair.attributes.add(name);
    const changed = (operation: string) => { pair.changed = true; pair.applied.add(operation); };
    if (mods.findReplace) {
      if (target.text !== null) throw new Error(CONTENT_CONFLICT);
      target.findReplace = true;
      openByAction[index].push(id);
      closer.onClose(() => openByAction[index].splice(openByAction[index].lastIndexOf(id), 1));
    } else if (mods.text !== null) {
      if (target.void) throw new Error("Cannot replace void element content");
      if (target.findReplace) throw new Error(CONTENT_CONFLICT);
      if (target.text === null) {
        element.prepend(`<!--rm-${nonce}-${id}-s-->`, { html: true });
        element.append(`<!--rm-${nonce}-${id}-e-->`, { html: true });
        for (const open of openTargets) if (open !== id) targets.get(open)!.containsRegion = true;
      }
      target.text = mods.text;
      changed("text");
    }
    for (const [name, value] of mods.attr) {
      attribute(name);
      if (readAttribute(element, name) !== String(value)) changed(`attr:${name}`);
      element.setAttribute(name, escapeAttribute(String(value)));
      if (name === "src" && element.tagName === "img") {
        attribute("srcset");
        if (element.hasAttribute("srcset")) { element.removeAttribute("srcset"); changed("attr:src"); }
      }
    }
    const styleEdits: Array<Array<[string, unknown]>> = [...mods.style.map(([name, value]): Array<[string, unknown]> => [[name, value]]), ...(mods.hide ? [[["display", "none"], ["visibility", "hidden"]] as Array<[string, unknown]>] : [])];
    styleEdits.forEach((edits, editIndex) => {
      const declarations = parseDeclarations(readAttribute(element, "style") || "");
      if (!declarations) return;
      const results = edits.map(([name, value]) => assignStyle(declarations, name, value));
      if (results.includes(null) || !results.includes("changed")) return;
      attribute("style");
      element.setAttribute("style", escapeAttribute(serializeDeclarations(declarations)));
      changed(editIndex < mods.style.length ? `style:${mods.style[editIndex][0]}` : "visibility");
    });
    if (mods.classes) {
      attribute("class");
      const current = [...new Set((readAttribute(element, "class") || "").replace(/\./g, " .").replace(/[., ]+/g, " ").split(" ").filter(Boolean))];
      const { add, remove } = mods.classes;
      const classes = current.concat((add || []).filter(name => !current.includes(name))).filter(name => !(remove || []).includes(name)).join(" ");
      if (classes !== readAttribute(element, "class")) changed("classes");
      element.setAttribute("class", escapeAttribute(classes));
    }
    return mods.text !== null;
  }, collectText);
  closer.install(rewriter);
  if (textSelectors.length) rewriter.on(textSelectors.join(","), {
    text(chunk) {
      if (!pending) return;
      if (insideRegion()) { pending = null; return; }
      pending.source += chunk.text;
      chunk.remove();
      if (!chunk.lastInTextNode) return;
      const { source, actions: active } = pending;
      pending = null;
      if (!source) return;
      const tag = raw.current();
      const original = tag ? source : decodeHTML(source);
      let value = original;
      const containing = new Set<string>();
      for (const index of [...active].sort((a, b) => a - b)) {
        for (const id of openByAction[index]) {
          containing.add(id);
          if (!value) continue;
          const next = replaceText(value, modifications[index].findReplace!);
          if (tag && next.toLowerCase().includes(`</${tag}`)) throw new Error("Raw text cannot be safely serialized");
          const pair = pairsByAction[index].get(id)!;
          if (next !== value) {
            pair.changed = true;
            pair.applied.add("findReplace");
            if (next === "") pair.emptied = true;
          }
          value = next;
        }
      }
      for (const id of containing) {
        const target = targets.get(id)!;
        target.textNodes.push({ index: target.textNodes.length, text: original });
        reserveBaseline(original);
        if (value === "") target.emptiedNode = true;
      }
      if (value === original) chunk.after(source, { html: true });
      else chunk.after(value, { html: !!tag });
    },
  });
  rewriter.onDocument({ end() {
    if (openTargets.length || openByAction.some(open => open.length)) throw new Error("Unclosed edge target");
  } });
  const output = new TextDecoder("utf-8", { fatal: true }).decode(await rewrite(bytes, rewriter));
  if (!pairs.length) return null;

  // Resolve originals and receipts in the browser's action order.
  const originals: Record<string, Original> = Object.create(null);
  const receipts: Receipt[] = [];
  const successes = new Map<string, string>();
  const needsHTML = new Set<string>();
  const ordered = [...pairs].sort((a, b) => a.index - b.index || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  for (const pair of ordered) {
    const target = targets.get(pair.id)!;
    const original: Original = originals[pair.id] ||= { attributes: Object.create(null), textNodes: [] };
    const attribute = (name: string) => { if (!Object.hasOwn(original.attributes, name)) original.attributes[name] = Object.hasOwn(target.attributes, name) ? target.attributes[name] : null; };
    for (const name of pair.attributes) attribute(name);
    if (pair.applied.has("text")) {
      original.html = null; // filled from the content region below
      original.textNodes = [];
    } else if (pair.applied.has("findReplace")) {
      if (!Object.hasOwn(original, "html")) original.textNodes = target.textNodes;
      if (pair.emptied) {
        needsHTML.add(pair.id);
        original.html = null;
        original.textNodes = [];
      }
    }
    if (pair.changed) {
      attribute("data-rm-personalized"); attribute("data-rm-variant");
      successes.set(pair.id, pair.action.variantId);
      const tested = versions[pair.index];
      receipts.push({ campaignId: pair.action.campaignId, variantId: pair.action.variantId, actionId: pair.action.actionId, targetId: pair.id, operations: [...pair.applied], ...(tested ? { versions: [...tested] } : {}) });
    }
  }
  if (!receipts.length) return null;
  if (heads !== 1) throw new Error(heads ? "Multiple document heads" : "Missing bootstrap insertion point");
  for (const id of successes.keys()) {
    const target = targets.get(id)!;
    const original = originals[id];
    // A text-node baseline must still describe the committed content: an emptied node or a
    // replaced descendant changes that structure, so the browser could not adopt it safely.
    if (!Object.hasOwn(original, "html") && original.textNodes.length && (target.containsRegion || target.emptiedNode)) throw new Error("Personalized text structure changed");
  }
  if (needsHTML.size) {
    const captured = await captureOriginalHTML(bytes, layout, needsHTML, Rewriter, rewrite);
    for (const [id, html] of captured) { reserveBaseline(html); originals[id].html = html; }
  }

  // Commit content regions, stamps and the receipt in one scan of the buffered output. Every
  // marker carries the nonce; each must occur exactly where and as often as it was inserted.
  const marker = new RegExp(` ${TARGET}="(e\\d+)" ${stamp}="\\1"|<!--rm-${nonce}-(e\\d+)-s-->([\\s\\S]*?)<!--rm-${nonce}-\\2-e-->|${headPlaceholder}`, "g");
  const matches = [...output.matchAll(marker)];
  const stamped = new Set<string>(), regions = new Set<string>();
  let placeholders = 0;
  for (const match of matches) {
    if (match[1]) {
      if (stamped.has(match[1])) throw new Error("Edge marker mismatch");
      stamped.add(match[1]);
    } else if (match[2]) {
      if (regions.has(match[2])) throw new Error("Edge marker mismatch");
      regions.add(match[2]);
      const original = originals[match[2]];
      if (original && !needsHTML.has(match[2])) { reserveBaseline(match[3]); original.html = match[3]; }
    } else placeholders++;
  }
  const textTargets = [...targets].filter(([, target]) => target.text !== null).map(([id]) => id);
  if (placeholders !== 1 || stamped.size !== targets.size || regions.size !== textTargets.length || !textTargets.every(id => regions.has(id))) throw new Error("Edge marker mismatch");
  for (const id of Object.keys(originals)) if (!successes.has(id)) delete originals[id];
  const envelope = { version: 1, revision: release.revision, receipts, originals };
  const head = `<meta name="rm-edge-loader" content="${release.loaderUrl.replace(/&/g, "&amp;")}"><script type="application/json" id="RM_EDGE">${encodeJSON(envelope)}</script>`;
  const pieces: Array<string | null> = [];
  let last = 0;
  for (const match of matches) {
    pieces.push(output.slice(last, match.index));
    if (match[1]) pieces.push(successes.has(match[1]) ? ` ${TARGET}="${match[1]}" data-rm-personalized="true" data-rm-variant="${escapeAttribute(successes.get(match[1])!)}"` : "");
    else if (match[2]) pieces.push(targets.get(match[2])!.text);
    else pieces.push(head);
    last = match.index + match[0].length;
  }
  pieces.push(output.slice(last));
  const result = encoder.encode(pieces.join(""));
  if (result.byteLength > OUTPUT_CAP) throw new Error("Personalization buffer limit");
  return result;
}
