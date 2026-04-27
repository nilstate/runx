/**
 * Internal concurrent executor for fanout branches.
 * No third-party dependencies. Uses native AbortController,
 * Promise.allSettled, and setTimeout.
 */

export interface FanoutTask<T> {
  readonly id: string;
  readonly fn: (signal: AbortSignal) => Promise<T>;
}

export interface FanoutResult<T> {
  readonly id: string;
  readonly status: "success" | "failure" | "aborted";
  readonly value?: T;
  readonly error?: string;
}

export interface FanoutOptions {
  readonly timeoutMs?: number;
}

export async function runFanout<T>(
  tasks: readonly FanoutTask<T>[],
  options: FanoutOptions = {},
): Promise<readonly FanoutResult<T>[]> {
  if (tasks.length === 0) return [];

  const controller = new AbortController();
  const { timeoutMs } = options;

  const taskPromises = tasks.map(async (task): Promise<FanoutResult<T>> => {
    // Per-task abort that fires on group abort OR per-task timeout
    const taskController = new AbortController();
    controller.signal.addEventListener("abort", () => taskController.abort(), { once: true });

    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => taskController.abort(), timeoutMs);
    }

    try {
      if (taskController.signal.aborted) {
        return { id: task.id, status: "aborted" };
      }
      const value = await task.fn(taskController.signal);
      return { id: task.id, status: "success", value };
    } catch (err) {
      if (taskController.signal.aborted) {
        return { id: task.id, status: "aborted" };
      }
      return {
        id: task.id,
        status: "failure",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  const settled = await Promise.allSettled(taskPromises);

  // Map back to declaration order (Promise.allSettled preserves order)
  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    // Should not happen since taskPromises catch internally, but handle gracefully
    return {
      id: tasks[i].id,
      status: "failure" as const,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
  });
}

/** Abort all remaining tasks. Call after policy evaluation decides to halt. */
export function createFanoutController(): {
  controller: AbortController;
  abort: () => void;
} {
  const controller = new AbortController();
  return {
    controller,
    abort: () => controller.abort(),
  };
}
