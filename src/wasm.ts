import { HTMLRewriter as WASMRewriter } from "html-rewriter-wasm";
import type { HTMLRewriterInstance, RewriterDocumentHandlers, RewriterElementHandlers } from "./rewriter-types.js";

/** Node-compatible HTMLRewriter backed by the optional html-rewriter-wasm peer. */
export class HTMLRewriter implements HTMLRewriterInstance {
  private readonly elements: Array<[string, RewriterElementHandlers]> = [];
  private readonly documents: RewriterDocumentHandlers[] = [];

  on(selector: string, handlers: RewriterElementHandlers): this {
    this.elements.push([selector, handlers]);
    return this;
  }

  onDocument(handlers: RewriterDocumentHandlers): this {
    this.documents.push(handlers);
    return this;
  }

  transform(response: Response): Response {
    if (!response.body) return new Response(null, response);
    const reader = response.body.getReader();
    let cancelled = false;
    let released = false;
    let emitted = false;
    let active: Promise<void> | undefined;
    let engine: WASMRewriter;
    const release = () => {
      if (released) return;
      released = true;
      engine.free();
      reader.releaseLock();
    };
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        engine = new WASMRewriter(chunk => {
          // The sink may expose WASM-owned memory; streams must own their queued bytes.
          if (!cancelled) {
            emitted = true;
            controller.enqueue(chunk.slice());
          }
        });
        try {
          for (const [selector, handlers] of this.elements) engine.on(selector, handlers);
          for (const handlers of this.documents) engine.onDocument(handlers);
        } catch (error) {
          void reader.cancel(error).catch(() => {});
          release();
          throw error;
        }
      },
      pull: controller => {
        active = (async () => {
          try {
            // A parser can consume several input chunks before emitting anything.
            // Keep feeding it until this pull can satisfy a pending read.
            emitted = false;
            while (!emitted && !cancelled) {
              const { done, value } = await reader.read();
              if (cancelled) return;
              if (done) {
                await engine.end();
                if (!cancelled) controller.close();
                release();
                return;
              }
              await engine.write(value);
            }
          } catch (error) {
            if (!cancelled) controller.error(error);
            void reader.cancel(error).catch(() => {});
            release();
          } finally {
            if (cancelled) release();
          }
        })();
        return active;
      },
      cancel: async reason => {
        cancelled = true;
        // Never free an engine while an async handler has its WASM stack suspended.
        void reader.cancel(reason).catch(() => {});
        await active;
        release();
      },
    });
    return new Response(body, response);
  }
}
