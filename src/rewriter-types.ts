/** The HTMLRewriter subset used by the transform, shared by native and WASM runtimes. */
export interface ContentOptions {
  html?: boolean;
}

export interface RewriterElement {
  readonly tagName: string;
  readonly namespaceURI: string;
  readonly attributes: Iterable<string[]>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): unknown;
  removeAttribute(name: string): unknown;
  prepend(content: string, options?: ContentOptions): unknown;
  append(content: string, options?: ContentOptions): unknown;
  onEndTag(handler: () => void | Promise<void>): void;
}

export interface RewriterTextChunk {
  readonly text: string;
  readonly lastInTextNode: boolean;
  remove(): unknown;
  after(content: string, options?: ContentOptions): unknown;
}

export interface RewriterElementHandlers {
  element?(element: RewriterElement): void | Promise<void>;
  text?(text: RewriterTextChunk): void | Promise<void>;
}

export interface RewriterDocumentHandlers {
  end?(): void | Promise<void>;
}

export interface HTMLRewriterInstance {
  on(selector: string, handlers: RewriterElementHandlers): HTMLRewriterInstance;
  onDocument(handlers: RewriterDocumentHandlers): HTMLRewriterInstance;
  transform(response: Response): Response;
}

export interface HTMLRewriterConstructor {
  new (): HTMLRewriterInstance;
}
