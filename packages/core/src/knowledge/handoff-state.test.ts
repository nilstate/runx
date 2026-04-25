import { describe, expect, it } from "vitest";

import { reduceHandoffState } from "./index.js";

describe("reduceHandoffState", () => {
  it("maps approved_to_send into the explicit pre-send state", () => {
    const state = reduceHandoffState({
      handoff_id: "sourcey.docs-pr:docs-refresh-example-repo",
      boundary_kind: "external_maintainer",
      target_repo: "example/repo",
      target_locator: "github://example/repo/issues/123",
      signals: [
        {
          schema: "runx.handoff_signal.v1",
          signal_id: "sig_accept_1",
          handoff_id: "sourcey.docs-pr:docs-refresh-example-repo",
          boundary_kind: "external_maintainer",
          target_repo: "example/repo",
          target_locator: "github://example/repo/issues/123",
          source: "issue_comment",
          disposition: "accepted",
          recorded_at: "2026-04-25T05:00:00Z",
        },
        {
          schema: "runx.handoff_signal.v1",
          signal_id: "sig_send_1",
          handoff_id: "sourcey.docs-pr:docs-refresh-example-repo",
          boundary_kind: "external_maintainer",
          target_repo: "example/repo",
          target_locator: "github://example/repo/issues/123",
          source: "manual_note",
          disposition: "approved_to_send",
          recorded_at: "2026-04-25T05:30:00Z",
        },
      ],
    });

    expect(state).toMatchObject({
      status: "approved_to_send",
      last_signal_disposition: "approved_to_send",
      summary: "approved_to_send from manual_note (approved_to_send)",
    });
  });
});
