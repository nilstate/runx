import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { projectContentReview } from "./review-content.mjs";

const subject = "A useful product update";
const html = "<h1>Product update</h1><p>What changed and why it matters.</p>";

test("projects exact product-safe content review output", () => {
  const projected = projectContentReview({
    subject,
    html,
    expected_html_digest: `sha256:${createHash("sha256").update(html).digest("hex")}`,
    provider_result: review(),
  });
  assert.deepEqual(projected, review());
  assert.equal(Object.hasOwn(projected, "private_provider_detail"), false);
});

test("refuses provider output that is not bound to the submitted content", () => {
  assert.throws(
    () => projectContentReview({
      subject,
      html,
      expected_html_digest: `sha256:${createHash("sha256").update(html).digest("hex")}`,
      provider_result: { ...review(), html_digest: "0".repeat(64) },
    }),
    /does not match/u,
  );
});

function review() {
  return {
    subject,
    html_size_bytes: Buffer.byteLength(html),
    html_digest: createHash("sha256").update(html).digest("hex"),
    text_preview: "Product update What changed and why it matters.",
    text_length: 47,
    accessibility: { valid: true, warnings: [] },
    spam_score: { score: 0, rating: "low", factors: [] },
    warnings: [],
  };
}
