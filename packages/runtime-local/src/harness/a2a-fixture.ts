import { createHash } from "node:crypto";

export interface A2aFixtureTask {
  readonly id: string;
  readonly status: "submitted" | "working" | "completed" | "failed" | "canceled";
  readonly output?: unknown;
  readonly error?: string;
}

export interface A2aFixtureTransport {
  readonly sendMessage: (request: {
    readonly agentCardUrl: string;
    readonly task: string;
    readonly message: Readonly<Record<string, unknown>>;
  }) => Promise<A2aFixtureTask>;
  readonly getTask: (request: { readonly taskId: string }) => Promise<A2aFixtureTask>;
  readonly cancelTask?: (request: { readonly taskId: string }) => Promise<A2aFixtureTask>;
}

export function createA2aFixtureTransport(): A2aFixtureTransport {
  const tasks = new Map<string, A2aFixtureTask>();

  return {
    sendMessage: async (request) => {
      if (!request.agentCardUrl.startsWith("fixture://")) {
        throw new Error("A2A fixture transport only supports fixture:// agent cards.");
      }

      const taskId = `a2a_${hashString(JSON.stringify(request)).slice(0, 16)}`;
      const task =
        request.task === "fail"
          ? { id: taskId, status: "failed" as const, error: "fixture failure" }
          : { id: taskId, status: "completed" as const, output: request.message.message ?? request.message };
      tasks.set(taskId, task);
      return task;
    },
    getTask: async (request) => {
      const task = tasks.get(request.taskId);
      if (!task) {
        throw new Error("A2A fixture task not found.");
      }
      return task;
    },
    cancelTask: async (request) => {
      const task = { id: request.taskId, status: "canceled" as const };
      tasks.set(request.taskId, task);
      return task;
    },
  };
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
