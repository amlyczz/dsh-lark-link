import { test } from "node:test";
import assert from "node:assert/strict";
import { createCardKitStream, CARD_SCHEMA, STREAM_ELEMENT_ID } from "../../../src/outbound/cardkit-stream.ts";

/**
 * Real CardKit v1 API shapes (official docs, verified 2026-08):
 * - create:     POST /open-apis/cardkit/v1/cards
 *               body {data:{type:"card_json",data:"<stringified card JSON>"}}
 * - deliver:    im/v1/messages msg_type "interactive"
 *               content {"type":"card","data":{"card_id"}} (entity sends ONCE)
 * - stream text:PUT /cards/:id/elements/:element_id/content
 *               body {content:"<FULL text>",sequence,uuid?}
 * - settings:   PATCH /cards/:id/settings
 *               body {settings:"<stringified config>",sequence,uuid?}
 * - full update:PUT /cards/:id
 *               body {card:{type:"card_json",data:"..."},sequence,uuid?}
 * sequence is strictly increasing PER CARD across all operations.
 */

function fakeApi() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  let nextId = 1;
  let seqSeen: Array<{ op: string; sequence: number }> = [];
  return {
    calls,
    seqSeen,
    api: {
      async createCard(payload: unknown) {
        calls.push({ op: "create", args: [payload] });
        return { card_id: `card-${nextId++}` };
      },
      async deliverCard(cardId: string) {
        calls.push({ op: "deliver", args: [cardId] });
        return {};
      },
      async streamText(cardId: string, elementId: string, body: { sequence: number }) {
        calls.push({ op: "streamText", args: [cardId, elementId, body] });
        seqSeen.push({ op: "streamText", sequence: body.sequence });
        return {};
      },
      async patchSettings(cardId: string, body: { sequence: number }) {
        calls.push({ op: "settings", args: [cardId, body] });
        seqSeen.push({ op: "settings", sequence: body.sequence });
        return {};
      },
      async updateCard(cardId: string, body: { sequence: number }) {
        calls.push({ op: "update", args: [cardId, body] });
        seqSeen.push({ op: "update", sequence: body.sequence });
        return {};
      },
    },
  };
}

function createPayloadOf(calls: Array<{ op: string; args: unknown[] }>) {
  const createCall = calls.find((c) => c.op === "create")!;
  // Official shape: the request body is FLAT {type:"card_json", data:"<json string>"}
  // (POST /open-apis/cardkit/v1/cards request body, verified 2026-08). The
  // earlier {data:{type,data}} wrapper was rejected by the API → no card.
  const payload = createCall.args[0] as { type: string; data: string };
  assert.equal(payload.type, "card_json");
  return JSON.parse(payload.data) as Record<string, unknown>;
}

test("cardkit: first patch creates a streaming card entity and delivers it", async () => {
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, printFrequencyMs: 1, printStep: 3 });
  await stream.patch("hello");
  assert.ok(stream.cardId.length > 0);

  const card = createPayloadOf(calls);
  assert.equal(card.schema, CARD_SCHEMA);
  const config = card.config as { streaming_mode: boolean; streaming_config: { print_frequency_ms: { default: number }; print_step: { default: number } } };
  assert.equal(config.streaming_mode, true, "card created with streaming_mode on");
  assert.equal(config.streaming_config.print_frequency_ms.default, 1);
  assert.equal(config.streaming_config.print_step.default, 3);
  const elements = (card.body as { elements: Array<{ tag: string; element_id: string }> }).elements;
  assert.equal(elements[0]!.tag, "markdown");
  assert.equal(elements[0]!.element_id, STREAM_ELEMENT_ID);

  // The card entity must be DELIVERED into the chat (im message with card_id) —
  // creating the entity alone shows nothing to the user.
  const deliver = calls.find((c) => c.op === "deliver")!;
  assert.equal(deliver.args[0], stream.cardId);
});

test("cardkit: streamText sends FULL accumulated text with strictly increasing sequence", async () => {
  const { api, calls, seqSeen } = fakeApi();
  let fakeNow = 0;
  const stream = createCardKitStream({ api, printFrequencyMs: 1, now: () => fakeNow });
  await stream.patch("one ");       // create + deliver
  fakeNow += 10;
  await stream.patch("two ");       // streamText("one ")
  fakeNow += 10;
  await stream.patch("three");      // streamText("one two ")

  const streams = calls.filter((c) => c.op === "streamText");
  assert.equal(streams.length, 2);
  const first = streams[0]!.args[2] as { content: string; sequence: number };
  const second = streams[1]!.args[2] as { content: string; sequence: number };
  // The create happens on chunk 1; the first streamText fires on chunk 2 and
  // already carries the FULL accumulated text (typewriter prefix extension).
  assert.equal(first.content, "one two ", "FULL text (typewriter extends the prefix)");
  assert.equal(second.content, "one two three");
  assert.ok(second.sequence > first.sequence, "sequence strictly increasing");
  assert.equal(streams[0]!.args[1], STREAM_ELEMENT_ID, "element path targets the markdown element");
  assert.ok(seqSeen.every((s) => Number.isInteger(s.sequence) && s.sequence >= 1));
});

test("cardkit: finalize disables streaming then PUTs the full card", async () => {
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, printFrequencyMs: 1 });
  await stream.patch("a");
  const cardId = stream.cardId;
  await stream.finalize("full text");

  const settings = calls.find((c) => c.op === "settings")!;
  const settingsBody = settings.args[1] as { settings: string };
  const parsed = JSON.parse(settingsBody.settings) as { config: { streaming_mode: boolean } };
  assert.equal(parsed.config.streaming_mode, false, "streaming disabled first");

  const update = calls.find((c) => c.op === "update")!;
  const updateBody = update.args[1] as { card: { type: string; data: string } };
  assert.equal(updateBody.card.type, "card_json");
  const finalCard = JSON.parse(updateBody.card.data) as { body: { elements: Array<{ tag: string; content: string }> } };
  assert.equal(finalCard.body.elements[0]!.content, "full text");
  assert.equal(update.args[0], cardId);
  assert.equal(stream.disposed, true);
});

test("cardkit: finalize sequence stays strictly increasing across settings+update", async () => {
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, printFrequencyMs: 1, now: () => 0 });
  await stream.patch("x");
  await stream.patch("y");
  await stream.finalize("full");
  const seqs = calls
    .filter((c) => c.op === "streamText" || c.op === "settings" || c.op === "update")
    .map((c) => (c.args[c.args.length - 1] as { sequence: number }).sequence);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "sequences strictly increase");
});

test("cardkit: create failure disposes (no crash) and surfaces onError", async () => {
  const api = {
    async createCard() {
      throw new Error("card api down");
    },
    async deliverCard() {
      throw new Error("unused");
    },
    async streamText() {
      throw new Error("unused");
    },
    async patchSettings() {
      throw new Error("unused");
    },
    async updateCard() {
      throw new Error("unused");
    },
  };
  let onError: unknown;
  const stream = createCardKitStream({ api, onError: (e) => (onError = e) });
  await stream.patch("x");
  assert.ok(onError, "error surfaced");
  assert.equal(stream.disposed, true);
  const id = await stream.finalize("y");
  assert.equal(id, "");
});

test("cardkit: deliver failure after create disposes and surfaces", async () => {
  const calls: Array<{ op: string }> = [];
  const api = {
    async createCard() {
      calls.push({ op: "create" });
      return { card_id: "card-d1" };
    },
    async deliverCard() {
      calls.push({ op: "deliver" });
      throw new Error("im send failed");
    },
    async streamText() {
      calls.push({ op: "streamText" });
      return {};
    },
    async patchSettings() {
      return {};
    },
    async updateCard() {
      return {};
    },
  };
  let onError: unknown;
  const stream = createCardKitStream({ api, onError: (e) => (onError = e) });
  await stream.patch("x");
  assert.equal(stream.disposed, true, "undeliverable card is unusable → dispose");
  assert.ok(onError);
  assert.equal(calls.filter((c) => c.op === "streamText").length, 0);
});

test("cardkit: throttles streamText to printFrequencyMs", async () => {
  let fakeNow = 0;
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, printFrequencyMs: 100, now: () => fakeNow });
  await stream.patch("one");       // t=0 create
  fakeNow += 10;
  await stream.patch("two");       // t=10 throttled
  fakeNow += 200;
  await stream.patch("three");     // t=210 allowed
  assert.equal(calls.filter((c) => c.op === "streamText").length, 1);
});

test("cardkit: finalize RE-THROWS when the final PUT fails (caller falls back to outbox)", async () => {
  const api = {
    async createCard() {
      return { card_id: "card-9" };
    },
    async deliverCard() {
      return {};
    },
    async streamText() {
      return {};
    },
    async patchSettings() {
      return {};
    },
    async updateCard() {
      throw new Error("final PUT failed");
    },
  };
  let onError: unknown;
  const stream = createCardKitStream({ api, onError: (e) => (onError = e) });
  await stream.patch("content");
  await assert.rejects(() => stream.finalize("full text"), /final PUT failed/);
  assert.ok(onError, "error surfaced via onError");
  assert.equal(stream.disposed, true);
});

test("cardkit: finalize with NO prior patches creates a non-streaming card, delivers it, and re-throws on failure", async () => {
  const failApi = {
    async createCard() {
      throw new Error("create failed");
    },
    async deliverCard() {
      return {};
    },
    async streamText() {
      return {};
    },
    async patchSettings() {
      return {};
    },
    async updateCard() {
      return {};
    },
  };
  const stream = createCardKitStream({ api: failApi });
  await assert.rejects(() => stream.finalize("x"), /create failed/);

  // Success path: plain card created + delivered, no streaming config.
  const { api, calls } = fakeApi();
  const stream2 = createCardKitStream({ api });
  const id = await stream2.finalize("done text");
  assert.ok(id.startsWith("card-"));
  const card = createPayloadOf(calls);
  const config = card.config as { streaming_mode?: boolean } | undefined;
  assert.notEqual(config?.streaming_mode, true, "no streaming mode on a finalized-only card");
  const elements = (card.body as { elements: Array<{ content: string }> }).elements;
  assert.equal(elements[0]!.content, "done text");
  assert.equal(calls.find((c) => c.op === "deliver")?.args[0], id);
});
