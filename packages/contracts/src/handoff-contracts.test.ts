import { describe, expect, it } from "vitest";

import {
  validateHandoffSignalContract,
  validateHandoffStateContract,
} from "./index.js";

describe("handoff contracts", () => {
  it("accepts the explicit approved_to_send handoff transition", () => {
    expect(validateHandoffSignalContract({
      schema: "runx.handoff_signal.v1",
      signal_id: "sig_send_1",
      handoff_id: "docs-pr:example/repo:001",
      boundary_kind: "external_maintainer",
      target_repo: "example/repo",
      target_locator: "github://example/repo/pulls/42",
      thread_locator: "github://example/repo/issues/123",
      outbox_entry_id: "pull_request:docs-refresh-example-repo",
      source: "manual_note",
      disposition: "approved_to_send",
      recorded_at: "2026-04-25T05:30:00Z",
    })).toMatchObject({
      disposition: "approved_to_send",
    });

    expect(validateHandoffStateContract({
      schema: "runx.handoff_state.v1",
      handoff_id: "docs-pr:example/repo:001",
      target_repo: "example/repo",
      status: "approved_to_send",
      signal_count: 2,
      last_signal_id: "sig_send_1",
      last_signal_at: "2026-04-25T05:30:00Z",
      last_signal_disposition: "approved_to_send",
    })).toMatchObject({
      status: "approved_to_send",
      last_signal_disposition: "approved_to_send",
    });
  });
});
