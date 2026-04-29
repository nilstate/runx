import { describe, expect, it } from "vitest";

import { createA2aFixtureTransport } from "@runxhq/runtime-local/harness";

import { createA2aAdapter, invokeA2a, type A2aTransport } from "./index.js";

const source = {
  type: "a2a",
  args: [],
  agentCardUrl: "fixture://echo-agent",
  agentIdentity: "echo-agent",
  task: "echo",
  arguments: { message: "{{message}}" },
  timeoutSeconds: 1,
  raw: {},
};

describe("invokeA2a", () => {
  it("throws when created without a transport", () => {
    expect(() => createA2aAdapter()).toThrow(
      "A2A adapter requires an explicit transport. Use createFixtureA2aTransport() only in tests or harnesses.",
    );
  });

  it("returns a clear failure when invoked without a transport", async () => {
    const result = await invokeA2a({
      source,
      inputs: { message: "hi" },
      skillDirectory: process.cwd(),
      env: process.env,
    });

    expect(result.status).toBe("failure");
    expect(result.errorMessage).toBe("A2A adapter requires an explicit transport.");
  });

  it("submits an A2A task through the fixture transport", async () => {
    const result = await invokeA2a(
      {
        source,
        inputs: { message: "hi" },
        skillDirectory: process.cwd(),
        env: process.env,
      },
      { transport: createA2aFixtureTransport() },
    );

    expect(result.status).toBe("success");
    expect(result.stdout).toBe("hi");
    expect(result.metadata?.a2a).toMatchObject({
      agent_identity: "echo-agent",
      task: "echo",
      task_status: "completed",
      agent_card_url_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      message_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      output_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("returns sanitized fixture failures", async () => {
    const result = await invokeA2a(
      {
        source: { ...source, task: "fail" },
        inputs: { message: "super-secret-value" },
        skillDirectory: process.cwd(),
        env: process.env,
      },
      { transport: createA2aFixtureTransport() },
    );

    expect(result.status).toBe("failure");
    expect(result.errorMessage).toBe("A2A task failed.");
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });

  it("cancels timed out tasks when the transport supports cancellation", async () => {
    const canceled: string[] = [];
    const transport: A2aTransport = {
      sendMessage: async () => ({ id: "a2a_hanging", status: "working" }),
      getTask: async () => ({ id: "a2a_hanging", status: "working" }),
      cancelTask: async (request) => {
        canceled.push(request.taskId);
        return { id: request.taskId, status: "canceled" };
      },
    };

    const result = await invokeA2a(
      {
        source: { ...source, timeoutSeconds: 0.05 },
        inputs: { message: "hi" },
        skillDirectory: process.cwd(),
        env: process.env,
      },
      { transport },
    );

    expect(result.status).toBe("failure");
    expect(result.errorMessage).toContain("timed out");
    expect(canceled).toEqual(["a2a_hanging"]);
  });

  it("reports sanitized cancellation failures in metadata", async () => {
    const transport: A2aTransport = {
      sendMessage: async () => ({ id: "a2a_hanging", status: "working" }),
      getTask: async () => ({ id: "a2a_hanging", status: "working" }),
      cancelTask: async () => {
        throw new Error("super-secret-cancel-token");
      },
    };

    const result = await invokeA2a(
      {
        source: { ...source, timeoutSeconds: 0.05 },
        inputs: { message: "hi" },
        skillDirectory: process.cwd(),
        env: process.env,
      },
      { transport },
    );

    expect(result.status).toBe("failure");
    expect(result.metadata?.a2a).toMatchObject({
      cancel_error: "A2A task cancellation failed.",
    });
    expect(JSON.stringify(result)).not.toContain("super-secret-cancel-token");
  });

  it("returns failure for missing A2A metadata", async () => {
    const result = await invokeA2a({
      source: {
        type: "a2a",
        args: [],
        raw: {},
      },
      inputs: {},
      skillDirectory: process.cwd(),
      env: process.env,
    });

    expect(result.status).toBe("failure");
    expect(result.errorMessage).toBe("A2A source requires agent_card_url and task metadata.");
  });
});
