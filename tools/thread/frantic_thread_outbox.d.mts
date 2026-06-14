export interface FranticThreadIntent {
  readonly kind: "thread.create" | "thread.comment" | "thread.labels" | "thread.close";
  readonly outbox_id: string;
  readonly provider: string;
  readonly thread_locator?: string;
  readonly source?: string;
  readonly source_ref: string;
  readonly event_id: number;
  readonly occurred_at: string;
  readonly room?: string;
  readonly posting_id: string;
  readonly bounty_number: number;
  readonly bounty_url: string;
  readonly receipt_ref?: string;
  readonly receipt_url?: string;
  readonly claim_id?: string;
  readonly target_repo?: string;
  readonly title?: string;
  readonly body?: string;
  readonly labels?: readonly string[];
  readonly dedupe_key?: string;
  readonly add_labels?: readonly string[];
  readonly remove_labels?: readonly string[];
  readonly reason?: "completed" | "not_planned";
}

export function normalizeFranticThreadIntent(intent: unknown): FranticThreadIntent;
export function buildFranticThreadProviderPush(
  intent: unknown,
  options?: {
    readonly adapterId?: string;
  },
): Record<string, unknown>;
