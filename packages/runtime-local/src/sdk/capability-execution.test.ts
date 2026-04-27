import { describe, expect, it } from "vitest";

import {
  buildCapabilityExecution,
  deriveCapabilityExecutionContentHash,
  deriveCapabilityExecutionIntentKey,
  deriveCapabilityExecutionTriggerKey,
} from "./capability-execution.js";

describe("capability execution envelope", () => {
  it("builds a stable generic envelope with semantic and trigger idempotency keys", () => {
    const envelope = buildCapabilityExecution({
      capabilityRef: "outreach",
      runner: "rerun",
      threadRef: "github://sourcey/sourcey.com/issues/3",
      requestedAt: "2026-04-25T14:00:00Z",
      transportKind: "github_issue_comment",
      triggerRef: "https://github.com/sourcey/sourcey.com/issues/3#issuecomment-1",
      scopeSet: ["docs.write", "thread:push"],
      actor: {
        actor_id: "auscaster",
        display_name: "auscaster",
        provider_identity: "github:auscaster",
      },
      inputOverrides: {
        objective: "Refresh the docs preview.",
        build_context: "Keep the MCP surface legible.",
      },
    });

    expect(envelope).toMatchObject({
      schema: "runx.capability_execution.v1",
      capability_ref: "outreach",
      runner: "rerun",
      thread_ref: "github://sourcey/sourcey.com/issues/3",
      transport: {
        kind: "github_issue_comment",
        trigger_ref: "https://github.com/sourcey/sourcey.com/issues/3#issuecomment-1",
        scope_set: ["docs.write", "thread:push"],
      },
      idempotency: {
        algorithm: "sha256",
      },
    });
    expect(envelope.idempotency.intent_key).toMatch(/^sha256:/);
    expect(envelope.idempotency.trigger_key).toMatch(/^sha256:/);
    expect(envelope.idempotency.content_hash).toMatch(/^sha256:/);
  });

  it("keeps the semantic intent key stable when undefined fields are omitted", () => {
    const first = deriveCapabilityExecutionIntentKey({
      capabilityRef: "outreach",
      runner: "rerun",
      threadRef: "github://sourcey/sourcey.com/issues/3",
      inputOverrides: {
        objective: "Refresh docs",
        pr_context: undefined,
      },
    });
    const second = deriveCapabilityExecutionIntentKey({
      capabilityRef: "outreach",
      runner: "rerun",
      threadRef: "github://sourcey/sourcey.com/issues/3",
      inputOverrides: {
        objective: "Refresh docs",
      },
    });

    expect(first).toBe(second);
    expect(deriveCapabilityExecutionContentHash({
      objective: "Refresh docs",
      ignored: undefined,
    })).toBe(deriveCapabilityExecutionContentHash({
      objective: "Refresh docs",
    }));
  });

  it("changes the trigger key without changing the semantic intent key", () => {
    const intentKey = deriveCapabilityExecutionIntentKey({
      capabilityRef: "outreach",
      runner: "rerun",
      threadRef: "github://sourcey/sourcey.com/issues/3",
      inputOverrides: {
        objective: "Refresh docs",
      },
    });

    expect(deriveCapabilityExecutionTriggerKey({
      transportKind: "github_issue_comment",
      triggerRef: "https://github.com/sourcey/sourcey.com/issues/3#issuecomment-1",
    })).not.toBe(deriveCapabilityExecutionTriggerKey({
      transportKind: "github_issue_comment",
      triggerRef: "https://github.com/sourcey/sourcey.com/issues/3#issuecomment-2",
    }));

    expect(intentKey).toBe(deriveCapabilityExecutionIntentKey({
      capabilityRef: "outreach",
      runner: "rerun",
      threadRef: "github://sourcey/sourcey.com/issues/3",
      inputOverrides: {
        objective: "Refresh docs",
      },
    }));
  });
});
