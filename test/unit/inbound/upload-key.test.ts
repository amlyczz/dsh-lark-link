import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUploadKey } from "../../../src/inbound/transport.ts";

test("extractUploadKey: real SDK top-level shape", () => {
  assert.equal(extractUploadKey({ file_key: "file_v2_uploaded" }, "file_key"), "file_v2_uploaded");
  assert.equal(extractUploadKey({ image_key: "img_v2_uploaded" }, "image_key"), "img_v2_uploaded");
});

test("extractUploadKey: legacy {data:{...}} shape tolerated", () => {
  assert.equal(extractUploadKey({ data: { file_key: "file_legacy" } }, "file_key"), "file_legacy");
  assert.equal(extractUploadKey({ data: { image_key: "img_legacy" } }, "image_key"), "img_legacy");
});

test("extractUploadKey: missing key returns undefined", () => {
  assert.equal(extractUploadKey({}, "file_key"), undefined);
  assert.equal(extractUploadKey({ data: {} }, "file_key"), undefined);
  assert.equal(extractUploadKey(null, "file_key"), undefined);
  assert.equal(extractUploadKey("nope", "file_key"), undefined);
});

test("extractUploadKey: top-level wins over nested when both present", () => {
  assert.equal(extractUploadKey({ file_key: "top", data: { file_key: "nested" } }, "file_key"), "top");
});
