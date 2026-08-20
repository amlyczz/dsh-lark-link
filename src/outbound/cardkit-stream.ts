// CardKit schema 2.0 streaming card client (ADR-8). Implements the OFFICIAL
// CardKit v1 flow (verified against open.feishu.cn docs, 2026-08):
//
//   1. POST /open-apis/cardkit/v1/cards
//      body {type:"card_json", data:"<stringified card JSON>"} (FLAT)
//      → {data:{card_id}} — creates a card ENTITY with streaming_mode on.
//   2. im/v1/messages (msg_type "interactive",
//      content {"type":"card","data":{"card_id"}}) — delivers the entity into
//      the chat. An entity can be sent EXACTLY ONCE, so this happens right
//      after creation.
//   3. PUT /cards/:card_id/elements/:element_id/content
//      body {content:"<FULL text>",sequence,uuid?} — streaming typewriter
//      updates. The API expects the full accumulated text; when the old text
//      is a prefix of the new one the client extends it with a typewriter
//      effect, so the handle accumulates chunk deltas itself.
//   4. finalize: PATCH /cards/:card_id/settings
//      body {settings:"<stringified {config:{streaming_mode:false}}>"} —
//      cosmetic (swallow errors) — then PUT /cards/:card_id
//      body {card:{type:"card_json",data:"…"},sequence} with the final
//      content. The final PUT is the durable delivery: its failure MUST
//      propagate so the caller (event-forwarder) falls back to the outbox.
//
// `sequence` must be strictly increasing across EVERY operation on the same
// card — one shared counter per handle. Ported pattern from pi-feishu-lark's
// cardkit-stream.ts, corrected to the documented payload shapes.

import { randomUUID } from "node:crypto";

export interface CardKitApi {
  /** POST /open-apis/cardkit/v1/cards — create a card entity. */
  createCard(payload: unknown): Promise<
    { card_id?: string; data?: { card_id?: string } } | undefined
  >;
  /** im/v1/messages — deliver the card entity into its chat (once per entity). */
  deliverCard(cardId: string): Promise<unknown>;
  /** PUT /cards/:id/elements/:elementId/content — full-text streaming update. */
  streamText(
    cardId: string,
    elementId: string,
    body: { content: string; sequence: number; uuid: string },
  ): Promise<unknown>;
  /** PATCH /cards/:id/settings — e.g. turn streaming_mode off. */
  patchSettings(
    cardId: string,
    body: { settings: string; sequence: number; uuid: string },
  ): Promise<unknown>;
  /** PUT /cards/:id — full card update (final content). */
  updateCard(
    cardId: string,
    body: {
      card: { type: "card_json"; data: string };
      sequence: number;
      uuid: string;
    },
  ): Promise<unknown>;
}

export interface CardKitStreamOptions {
  api: CardKitApi;
  /** ms between server-side typewriter pushes (config at create time). */
  printFrequencyMs?: number;
  /** print_step for the client typewriter (config at create time). */
  printStep?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export interface CardKitStreamHandle {
  cardId: string;
  /** Append a text delta; the handle sends FULL accumulated text. */
  patch(text: string): Promise<void>;
  /** Finalize: disable streaming, PUT full content. Returns final card id. */
  finalize(fullText: string): Promise<string>;
  /** Send a plain-text fallback when cards are unavailable. */
  fallbackText?: (text: string) => Promise<unknown>;
  disposed: boolean;
}

const CARD_SCHEMA = "2.0";
/** element_id of the single markdown element (1–20 chars per API rules). */
const STREAM_ELEMENT_ID = "stream_md";
/** Safety valve: stop patching beyond this many API calls; finalize covers it. */
const MAX_STREAM_PATCHES = 400;

export function createCardKitStream(
  opts: CardKitStreamOptions,
): CardKitStreamHandle {
  let cardId: string | undefined;
  let seq = 0; // strictly increasing across ALL ops on this card
  let lastPatchAt = 0;
  let patchCount = 0;
  let disposed = false;
  let acc = ""; // accumulated text — the API takes FULL text every push
  const now = opts.now ?? Date.now;

  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };

  const cardJson = (text: string, streaming: boolean): string =>
    JSON.stringify({
      schema: CARD_SCHEMA,
      ...(streaming
        ? {
            config: {
              streaming_mode: true,
              streaming_config: {
                print_frequency_ms: { default: opts.printFrequencyMs ?? 120 },
                print_step: { default: opts.printStep ?? 3 },
                print_strategy: "fast",
              },
              summary: { content: "" },
            },
          }
        : {}),
      body: {
        elements: [
          { tag: "markdown", content: text, element_id: STREAM_ELEMENT_ID },
        ],
      },
    });

  const createPayload = (text: string, streaming: boolean): unknown => ({
    // FLAT body per the official create doc: {type:"card_json", data:"<json>"}
    // — NOT wrapped under a `data` envelope (that shape 400s and the card
    // never appears).
    type: "card_json" as const,
    data: cardJson(text, streaming),
  });

  const extractCardId = (
    res: { card_id?: string; data?: { card_id?: string } } | undefined,
  ): string | undefined => res?.card_id ?? res?.data?.card_id;

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
      if (patchCount >= MAX_STREAM_PATCHES) return; // finalize covers the rest
      acc += text;
      if (cardId === undefined) {
        // First chunk: create the streaming entity AND deliver it — an
        // undelivered entity is invisible to the user.
        try {
          const created = await opts.api.createCard(createPayload("", true));
          cardId = extractCardId(created);
          if (!cardId) throw new Error("CardKit create returned no card_id");
          await opts.api.deliverCard(cardId);
          patchCount++;
          lastPatchAt = now();
        } catch (err) {
          opts.onError?.(err);
          disposed = true;
          return;
        }
        return;
      }
      // Throttle: at most one push per printFrequencyMs.
      if (now() - lastPatchAt < (opts.printFrequencyMs ?? 120)) return;
      lastPatchAt = now();
      try {
        await opts.api.streamText(cardId, STREAM_ELEMENT_ID, {
          content: acc,
          sequence: nextSeq(),
          uuid: randomUUID(),
        });
        patchCount++;
      } catch (err) {
        opts.onError?.(err);
        // Non-fatal: finalize still lands the full content.
      }
    },
    async finalize(fullText) {
      if (disposed) return cardId ?? "";
      const text = fullText || acc;
      if (!cardId) {
        // Never streamed a chunk — create a plain (non-streaming) card with
        // the full content and deliver it. Failure PROPAGATES so the caller
        // falls back to the durable outbox (content must not be lost).
        try {
          const created = await opts.api.createCard(createPayload(text, false));
          cardId = extractCardId(created);
          if (!cardId) throw new Error("CardKit create returned no card_id");
          await opts.api.deliverCard(cardId);
          disposed = true;
          return cardId;
        } catch (err) {
          opts.onError?.(err);
          disposed = true;
          throw err;
        }
      }
      const id = cardId;
      // 1) Turn streaming OFF (PATCH settings) — cosmetic, swallow failure.
      try {
        await opts.api.patchSettings(id, {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence: nextSeq(),
          uuid: randomUUID(),
        });
      } catch (err) {
        opts.onError?.(err);
      }
      // 2) PUT the full content — the durable delivery. Failure propagates.
      try {
        await opts.api.updateCard(id, {
          card: { type: "card_json", data: cardJson(text, false) },
          sequence: nextSeq(),
          uuid: randomUUID(),
        });
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

export { CARD_SCHEMA, STREAM_ELEMENT_ID };
