import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventForwarder, type StreamTarget } from "../../../src/outbound/event-forwarder.ts";
import { createOutbox, type Outbox, type OutboxSender } from "../../../src/outbound/outbox.ts";
import { tempDir } from "../../../src/common/dedupe-store.ts";
import type { Route, RouteRef } from "../../../src/common/types.ts";
import type { CardKitStreamHandle } from "../../../src/outbound/cardkit-stream.ts";

const route: Route = { sessionKey: "dm:ou_x", chatId: "oc_x", chatType: "p2p", updatedAt: 0 };
const routeRef: RouteRef = { sessionKey: "dm:ou_x", chatId: "oc_x", chatType: "p2p" };

function makeForwarder(opts: { streaming?: boolean; failStream?: boolean; finalizeThrows?: boolean } = {}) {
  const sent: unknown[] = [];
  const sender: OutboxSender = {
    async deliver(_env, payload) {
      sent.push(payload);
      return { ok: true };
    },
  };
  const outbox: Outbox = createOutbox({
    dir: tempDir("fw-"),
    sender,
    cfg: { maxAttempts: 5, backoffMaxMs: 100, retainDays: 7, pendingCap: 1000, blobThreshold: 24_000 },
  });
  outbox.rebuildFromDisk();
  outbox.start();

  const streamPatches: string[] = [];
  const finalized: string[] = [];
  let doneCount = 0;
  const fakeStream: CardKitStreamHandle = {
    cardId: "card-1",
    disposed: false,
    async patch(t: string) {
      streamPatches.push(t);
    },
    async finalize(t: string) {
      finalized.push(t);
      if (opts.finalizeThrows) throw new Error("finalize down");
      return "card-1";
    },
  };
  const streamTarget: StreamTarget = {
    route: routeRef,
    ensureStream() {
      return opts.failStream ? undefined : fakeStream;
    },
    async fallbackText(text) {
      await outbox.enqueue({ dedupeKey: `fb:${Date.now()}`, laneKey: "dm:ou_x", route: routeRef, kind: "final", payload: { kind: "text", text } });
    },
    async markDone() {
      doneCount++;
    },
  };

  const fw = createEventForwarder({
    outbox,
    routeFor: (key) => (key === "dm:ou_x" ? route : undefined),
    streamFor: () => streamTarget,
    cfg: () => ({ streamingEnabled: opts.streaming ?? true }),
  });

  return { fw, outbox, sent, streamPatches, finalized, doneCount: () => doneCount };
}

test("forwarder: assistant/message settles the final text on the stream card", async () => {
  const { fw, finalized } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "hel" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "lo" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "hello" });
  assert.deepEqual(finalized, ["hello"]);
});

test("forwarder: finalize failure falls through to the durable outbox (no content loss)", async () => {
  const { fw, sent } = makeForwarder({ finalizeThrows: true });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "durable content" });
  await new Promise((r) => setTimeout(r, 200)); // let the outbox drain
  const texts = sent.filter((p) => (p as { kind: string }).kind === "text" && (p as { text: string }).text === "durable content");
  assert.equal(texts.length, 1, "finalize failure fell back to a durable text delivery");
});

test("forwarder: turn/end marks done (real output) but does NOT re-send final (pi bdbc0a2)", async () => {
  const { fw, sent, doneCount } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "hello" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "complete" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(doneCount(), 1, "DONE issued for real output");
  const texts = sent.filter((p) => (p as { kind: string }).kind === "text");
  assert.equal(texts.length, 1, "exactly one delivery — no duplicate on turn/end");
});

test("forwarder: empty output is skipped, no DONE (pi 5ac1c3d)", async () => {
  const { fw, sent, doneCount } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "complete" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, 0, "no message for empty output");
  assert.equal(doneCount(), 0, "no DONE for empty output");
});

test("forwarder: 'No response.' is treated as empty (pi 5ac1c3d)", async () => {
  const { fw, sent, doneCount } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "No response." });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "complete" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, 0);
  assert.equal(doneCount(), 0);
});

test("forwarder: each assistant/message is delivered as one message (多轮逐条发, 默认非流式)", async () => {
  const { fw, sent, outbox } = makeForwarder({ streaming: false });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "first" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "second" });
  await fw.onSessionEvent("dm:ou_x", { type: "turn/end", reason: "complete" });
  await new Promise((r) => setTimeout(r, 200));
  const texts = sent.filter((p) => (p as { kind: string }).kind === "text");
  assert.equal(texts.length, 2, "two rounds → two messages");
  assert.equal(outbox.pendingCount(), 0, "all delivered");
});

test("forwarder: streaming disabled => final goes through outbox only", async () => {
  const { fw, sent, finalized } = makeForwarder({ streaming: false });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "hello" });
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/message", text: "hello" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(finalized.length, 0, "no stream card");
  assert.ok(sent.length >= 1, "outbox final delivered");
});

test("forwarder: session without route is ignored", async () => {
  const { fw, sent } = makeForwarder();
  await fw.onSessionEvent("other-session", { type: "assistant/message", text: "nope" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 0);
});

test("forwarder: finalizeSession flushes pending stream-only text", async () => {
  const { fw, sent } = makeForwarder();
  await fw.onSessionEvent("dm:ou_x", { type: "assistant/chunk", text: "pending text" });
  await fw.finalizeSession("dm:ou_x");
  await new Promise((r) => setTimeout(r, 200));
  const texts = sent.filter((p) => (p as { kind: string }).kind === "text");
  assert.ok(texts.some((t) => (t as { text: string }).text === "pending text"));
});
