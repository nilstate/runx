import assert from "node:assert/strict";
import test from "node:test";

import { prepareReadback, requireCompleteReadback } from "./readback.mjs";

test("projects the only durable connector read input", () => {
  assert.deepEqual(prepareReadback({ payment_ref: "runx:x402-payment:test" }), {
    readback_request: { payment_ref: "runx:x402-payment:test" },
  });
});

test("requires terminal confirmed receipt for synchronous pay", () => {
  assert.deepEqual(requireCompleteReadback({
    readback: {
      readback_status: "complete",
      finality: "confirmed",
      inner_receipt_ref: `runx:receipt:sha256:${"a".repeat(64)}`,
    },
  }), { verified: { readback_status: "complete" } });
  assert.throws(
    () => requireCompleteReadback({ readback: { readback_status: "pending" } }),
    /durable readback/u,
  );
});
