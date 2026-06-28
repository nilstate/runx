export interface ThreadDesiredComment {
  readonly entry_id: string;
  readonly body: string;
  readonly receipt_ref?: string;
}

export interface ThreadDesiredState {
  readonly provider: string;
  readonly target_repo: string;
  readonly identity_key: string;
  readonly thread_locator?: string;
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
  readonly managed_labels?: readonly string[];
  readonly state: "open" | "closed";
  readonly close_reason?: "completed" | "not_planned";
  readonly comments?: readonly ThreadDesiredComment[];
  readonly ref?: Record<string, string | number>;
}

export interface ThreadFrameOptions {
  readonly adapterId?: string;
  readonly sourceId?: string;
}

export function normalizeThread(thread: unknown): ThreadDesiredState;
export function buildCreateFrame(thread: unknown, options?: ThreadFrameOptions): Record<string, unknown>;
export function buildLifecycleFrame(
  thread: unknown,
  locator: string,
  options?: ThreadFrameOptions,
): Record<string, unknown>;
export function buildMessageFrame(
  thread: unknown,
  comment: unknown,
  locator: string,
  options?: ThreadFrameOptions,
): Record<string, unknown>;
