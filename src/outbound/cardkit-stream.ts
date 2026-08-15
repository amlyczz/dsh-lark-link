// CardKit schema 2.0 streaming card client (ADR-8). Creates a streaming card
// (streaming_mode + print_frequency_ms/print_step so the Feishu client
// typewriter-prints), patches content, and finalizes by first PATCHing the
// streaming settings off, then PUTting the full content. Sequence+uuid guards
// against out-of-order patches. Falls back to plain-text messages when the
// card API is unavailable. Ported pattern from pi-feishu-lark's
// cardkit-stream.ts.

import { randomUUID } from "node:crypto";

export interface CardKitApi {
  createCard(payload: unknown): Promise<{ card_id?: string; data?: { card_id?: string } }>;
  patchCard(cardId: string, patch: unknown): Promise<unknown>;
  updateCard(cardId: string, content: unknown): Promise<unknown>;
}

export interface CardKitStreamOptions {
  api: CardKitApi;
  /** ms between server-side content pushes. */
  printFrequencyMs?: number;
  /** print_step for the client typewriter. */
  printStep?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export interface CardKitStreamHandle {
  cardId: string;
  /** Append text to the streaming card (throttled by the caller). */
  patch(text: string): Promise<void>;
  /** Finalize: disable streaming, PUT full content. Returns final card id. */
  finalize(fullText: string): Promise<string>;
  /** Send a plain-text fallback when cards are unavailable. */
  fallbackText?: (text: string) => Promise<unknown>;
  disposed: boolean;
}

const CARD_SCHEMA = "2.0";
const CARD_TOKEN = "main";
const MAX_STREAM_PATCHES = 400;

export function createCardKitStream(opts: CardKitStreamOptions): CardKitStreamHandle {
  let cardId: string | undefined;
  let seq = 0;
  let lastPatchAt = 0;
  let patchCount = 0;
  let disposed = false;
  const now = opts.now ?? Date.now;

  const content = (text: string): unknown => ({
    schema: CARD_SCHEMA,
    body: {
      elements: [
        {
          tag: "markdown",
          content: text,
        },
      ],
    },
  });

  const streamingConfig = (): unknown => ({
    card_id: cardId,
    schema: CARD_SCHEMA,
    streaming_mode: {
      stream: true,
      print_frequency_ms: opts.printFrequencyMs ?? 120,
      print_step: opts.printStep ?? 3,
    },
  });

  return {
    // Live getters — the closure fields mutate after creation (never snapshot).
    get cardId() {
      return cardId ?? "";
    },
    get disposed() {
      return disposed;
    },
    async patch(text) {
      if (disposed) return;
      if (patchCount >= MAX_STREAM_PATCHES) return; // stop patching; finalize covers it
      if (cardId === undefined) {
        // First call creates the card with streaming mode on.
        try {
          const created = await opts.api.createCard(streamingConfig());
          cardId = created.card_id ?? created.data?.card_id;
          if (!cardId) throw new Error("CardKit create returned no card_id");
          patchCount++;
          lastPatchAt = now();
          return;
        } catch (err) {
          opts.onError?.(err);
          disposed = true;
          return;
        }
      }
      // Throttle: at most one push per printFrequencyMs.
      if (now() - lastPatchAt < (opts.printFrequencyMs ?? 120)) return;
      lastPatchAt = now();
      seq++;
      try {
        await opts.api.patchCard(cardId, {
          card_id: cardId,
          schema: CARD_SCHEMA,
          sequence: seq,
          uuid: randomUUID(),
          patch: {
            body: {
              elements: [{ tag: "markdown", content: text }],
            },
          },
        });
        patchCount++;
      } catch (err) {
        opts.onError?.(err);
        // Non-fatal: finalize still lands the full content.
      }
    },
    async finalize(fullText) {
      if (disposed) return cardId ?? "";
      if (!cardId) {
        // Never created a card — try a plain create (non-streaming). If this
        // fails, PROPAGATE so the caller can fall back to the durable outbox
        // (otherwise the content would be lost).
        try {
          const created = await opts.api.createCard(content(fullText));
          cardId = created.card_id ?? created.data?.card_id;
          disposed = true;
          return cardId ?? "";
        } catch (err) {
          opts.onError?.(err);
          disposed = true;
          throw err;
        }
      }
      const id = cardId;
      // 1) Turn streaming OFF (PATCH settings), 2) PUT the full content.
      // The settings-off PATCH is cosmetic (streaming staying on vs. losing
      // content) so its failure is swallowed. The final content PUT is the
      // durable delivery — its failure MUST propagate so the caller can fall
      // back to the outbox rather than silently dropping the reply.
      try {
        await opts.api.patchCard(id, {
          card_id: id,
          schema: CARD_SCHEMA,
          patch: {
            settings: { streaming_mode: { stream: false } },
          },
        });
      } catch (err) {
        opts.onError?.(err);
      }
      try {
        await opts.api.updateCard(id, content(fullText));
      } catch (err) {
        opts.onError?.(err);
        disposed = true;
        throw err;
      }
      disposed = true;
      return id;
    },
  };
}

export { CARD_SCHEMA, CARD_TOKEN };
