import { test } from "node:test";
import assert from "node:assert/strict";
import { createCardKitStream, CARD_SCHEMA } from "../../../src/outbound/cardkit-stream.ts";

function fakeApi() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  let nextId = 1;
  return {
    calls,
    api: {
      async createCard(payload: unknown) {
        calls.push({ op: "create", args: [payload] });
        return { card_id: `card-${nextId++}` };
      },
      async patchCard(cardId: string, patch: unknown) {
        calls.push({ op: "patch", args: [cardId, patch] });
        return {};
      },
      async updateCard(cardId: string, content: unknown) {
        calls.push({ op: "update", args: [cardId, content] });
        return {};
      },
    },
  };
}

test("cardkit: first patch creates a streaming card", async () => {
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, printFrequencyMs: 1, printStep: 3 });
  await stream.patch("hello");
  assert.ok(stream.cardId.length > 0);
  const createCall = calls.find((c) => c.op === "create");
  assert.ok(createCall, "create called");
  const payload = createCall!.args[0] as { schema: string; streaming_mode: { stream: boolean; print_frequency_ms: number } };
  assert.equal(payload.schema, CARD_SCHEMA);
  assert.equal(payload.streaming_mode.stream, true);
  assert.equal(payload.streaming_mode.print_frequency_ms, 1);
});

test("cardkit: finalize turns streaming off then PUTs full content", async () => {
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, printFrequencyMs: 1 });
  await stream.patch("a");
  const cardId = stream.cardId;
  await stream.finalize("full text");
  const patch = calls.find((c) => c.op === "patch")!;
  const patchPayload = patch.args[1] as { patch: { settings: { streaming_mode: { stream: boolean } } } };
  assert.equal(patchPayload.patch.settings.streaming_mode.stream, false, "streaming disabled first");
  const update = calls.find((c) => c.op === "update")!;
  const content = update.args[1] as { schema: string; body: { elements: Array<{ tag: string; content: string }> } };
  assert.equal(content.body.elements[0]!.content, "full text");
  assert.equal(stream.disposed, true);
});

test("cardkit: create failure falls back (disposed, no crash)", async () => {
  const api = {
    async createCard() {
      throw new Error("card api down");
    },
    async patchCard() {
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
  // finalize of a disposed stream is a no-op returning ""
  const id = await stream.finalize("y");
  assert.equal(id, "");
});

test("cardkit: throttles patches to printFrequencyMs", async () => {
  let fakeNow = 0;
  const { api, calls } = fakeApi();
  const stream = createCardKitStream({ api, printFrequencyMs: 100, now: () => fakeNow });
  await stream.patch("one");
  fakeNow += 10;
  await stream.patch("two"); // throttled
  fakeNow += 200;
  await stream.patch("three"); // allowed
  const patchCalls = calls.filter((c) => c.op === "patch");
  assert.equal(patchCalls.length, 1);
});
