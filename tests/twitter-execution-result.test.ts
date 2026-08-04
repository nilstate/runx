import { describe, expect, it } from "vitest";

import { finalizeExecution } from "../skills/twitter/twitter-execution-result.mjs";

describe("twitter execution provider outcomes", () => {
  it("treats following:false as a completed unfollow", () => {
    const execution = finalize("unfollow", { following: false });

    expect(execution).toMatchObject({
      decision: "executed",
      next_act_index: 1,
      remaining_count: 0,
      results: [
        {
          kind: "unfollow",
          status: "done",
          provider_ref: "target-1",
          detail: null,
        },
      ],
    });
  });

  it("requires each typed mutation to reach its requested state", () => {
    expect(finalize("unfollow", { following: true })).toMatchObject({
      decision: "partial",
      next_act_index: 0,
      results: [{ status: "failed" }],
    });
    expect(finalize("follow", { following: true })).toMatchObject({
      decision: "executed",
      next_act_index: 1,
      results: [{ status: "done" }],
    });
    expect(finalize("follow", { following: false })).toMatchObject({
      decision: "partial",
      next_act_index: 0,
      results: [{ status: "failed" }],
    });
    expect(finalize("delete_post", { deleted: false })).toMatchObject({
      decision: "partial",
      next_act_index: 0,
      results: [{ status: "failed" }],
    });
  });

  it("advances an unfollow when X reports the inactive target is already unfollowable", () => {
    const execution = finalizeResponse("unfollow", {
      ok: false,
      status: 400,
      json: {
        detail: "One or more parameters to your request was invalid.",
        errors: [{ message: "You cannot unfollow an account that is not active." }],
        title: "Invalid Request",
      },
    });

    expect(execution).toMatchObject({
      decision: "executed",
      next_act_index: 1,
      remaining_count: 0,
      results: [
        {
          kind: "unfollow",
          status: "done",
          provider_ref: "target-1",
          detail: "Target account is inactive; the requested not-following state is already satisfied.",
        },
      ],
      ledger_delta: {
        batch: {
          completed_act_count: 1,
          failed: false,
        },
      },
    });
  });

  it("does not weaken other provider failures or other 400 responses", () => {
    expect(finalizeResponse("unfollow", {
      ok: false,
      status: 400,
      json: { errors: [{ message: "Another invalid request." }] },
    })).toMatchObject({
      decision: "partial",
      next_act_index: 0,
      results: [{ status: "failed", detail: "Another invalid request." }],
    });

    expect(finalizeResponse("follow", {
      ok: false,
      status: 400,
      json: { errors: [{ message: "You cannot unfollow an account that is not active." }] },
    })).toMatchObject({
      decision: "partial",
      next_act_index: 0,
      results: [{ status: "failed" }],
    });
  });

  it("advances only the inactive target when stop-on-error left later acts unperformed", () => {
    const plan = executionPlan("unfollow");
    plan.total_act_count = 2;
    plan.remaining_count = 2;
    plan.act_groups.push({
      ...plan.act_groups[0],
      act_id: "act-002",
      act_index: 1,
      fallback_provider_ref: "target-2",
      request_ids: ["act:act-002"],
    });

    const execution = finalizeExecution({
      execution_plan: plan,
      http_execution: {
        responses: [{
          id: "act:act-001",
          ok: false,
          status: 400,
          json: { errors: [{ message: "You cannot unfollow an account that is not active." }] },
        }],
      },
    }).twitter_execution;

    expect(execution).toMatchObject({
      decision: "partial",
      next_act_index: 1,
      remaining_count: 1,
      results: [
        { act_id: "act-001", status: "done", provider_ref: "target-1" },
      ],
      ledger_delta: {
        batch: {
          completed_act_count: 1,
          failed: false,
        },
      },
    });
  });
});

function finalize(kind: string, data: Record<string, unknown>) {
  return finalizeResponse(kind, {
    ok: true,
    status: 200,
    json: { data },
  });
}

function finalizeResponse(kind: string, response: Record<string, unknown>) {
  return finalizeExecution({
    execution_plan: executionPlan(kind),
    http_execution: {
      responses: [
        {
          id: "act:act-001",
          ...response,
        },
      ],
    },
  }).twitter_execution;
}

function executionPlan(kind: string) {
  return {
    decision: "ready",
    plan_digest: "sha256:fixture",
    principal: "account:@fixture",
    start_act_index: 0,
    next_act_index: 0,
    total_act_count: 1,
    remaining_count: 1,
    act_groups: [
      {
        act_id: "act-001",
        act_index: 0,
        kind,
        consequence: "live_mutation",
        fallback_provider_ref: "target-1",
        request_ids: ["act:act-001"],
      },
    ],
  };
}
