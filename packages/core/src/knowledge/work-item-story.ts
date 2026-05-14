import {
  optionalEnum,
  optionalString,
  optionalStringArray,
  requireArray,
  requireEnum,
  requireRecord,
  requireString,
  validateEvidenceRef,
  type EvidenceRef,
} from "./internal-validators.js";
import type { OutboxEntry } from "./outbox.js";

export type WorkItemStoryMilestoneKind =
  | "intake"
  | "triage"
  | "spec"
  | "build"
  | "review"
  | "pull_request"
  | "merge_gate"
  | "outcome";

export type WorkItemStoryMilestoneStatus =
  | "pending"
  | "ready"
  | "passed"
  | "failed"
  | "blocked"
  | "completed";

export interface WorkItemStoryMilestone {
  readonly kind: WorkItemStoryMilestoneKind;
  readonly status?: WorkItemStoryMilestoneStatus;
  readonly title?: string;
  readonly summary: string;
  readonly details?: readonly string[];
  readonly evidence?: readonly EvidenceRef[];
}

export interface WorkItemStory {
  readonly thread_locator: string;
  readonly title?: string;
  readonly next_action?: string;
  readonly milestones: readonly WorkItemStoryMilestone[];
}

export interface BuildWorkItemStoryOutboxEntryOptions {
  readonly taskId: string;
  readonly threadLocator: string;
  readonly milestone: WorkItemStoryMilestone | Readonly<Record<string, unknown>>;
  readonly title?: string;
  readonly workflow?: string;
  readonly bodyMarkdown?: string;
  readonly updatedAt?: string;
}

const milestoneKinds = [
  "intake",
  "triage",
  "spec",
  "build",
  "review",
  "pull_request",
  "merge_gate",
  "outcome",
] as const;

const milestoneStatuses = [
  "pending",
  "ready",
  "passed",
  "failed",
  "blocked",
  "completed",
] as const;

export function validateWorkItemStoryMilestone(
  value: unknown,
  label = "work_item_story_milestone",
): WorkItemStoryMilestone {
  const record = requireRecord(value, label);
  const evidence = record.evidence === undefined
    ? undefined
    : requireArray(record.evidence, `${label}.evidence`).map((entry, index) =>
        validateEvidenceRef(entry, `${label}.evidence[${index}]`),
      );
  return {
    kind: requireEnum(record.kind, milestoneKinds, `${label}.kind`),
    status: optionalEnum(record.status, milestoneStatuses, `${label}.status`),
    title: sanitizePublicMarkdown(optionalString(record.title, `${label}.title`)),
    summary: sanitizePublicMarkdown(requireString(record.summary, `${label}.summary`)) ?? "",
    details: optionalStringArray(record.details, `${label}.details`)
      ?.map((entry) => sanitizePublicMarkdown(entry) ?? ""),
    evidence,
  };
}

export function validateWorkItemStory(value: unknown, label = "work_item_story"): WorkItemStory {
  const record = requireRecord(value, label);
  return {
    thread_locator: sanitizePublicMarkdown(requireString(record.thread_locator, `${label}.thread_locator`)) ?? "",
    title: sanitizePublicMarkdown(optionalString(record.title, `${label}.title`)),
    next_action: sanitizePublicMarkdown(optionalString(record.next_action, `${label}.next_action`)),
    milestones: requireArray(record.milestones, `${label}.milestones`).map((entry, index) =>
      validateWorkItemStoryMilestone(entry, `${label}.milestones[${index}]`),
    ),
  };
}

export function renderWorkItemStoryMarkdown(value: WorkItemStory | Readonly<Record<string, unknown>>): string {
  const story = validateWorkItemStory(value);
  const lines = [
    `## ${story.title ?? "Issue-to-PR story"}`,
    "",
    `Source thread: \`${story.thread_locator}\``,
    "",
    "### Gate Summary",
  ];

  for (const milestone of story.milestones) {
    const status = milestone.status ? ` (${milestone.status})` : "";
    lines.push(`- ${formatMilestoneKind(milestone.kind)}${status}: ${milestone.summary}`);
    for (const detail of milestone.details ?? []) {
      lines.push(`  - ${detail}`);
    }
  }

  if (story.next_action) {
    lines.push("", `Next: ${story.next_action}`);
  }

  return `${lines.join("\n")}\n`;
}

export function buildWorkItemStoryOutboxEntry(
  options: BuildWorkItemStoryOutboxEntryOptions,
): OutboxEntry {
  const milestone = validateWorkItemStoryMilestone(options.milestone);
  const workflow = normalizeIdentifierSegment(options.workflow ?? "issue-to-pr");
  const taskId = normalizeIdentifierSegment(options.taskId);
  const bodyMarkdown = sanitizePublicMarkdown(
    options.bodyMarkdown ?? renderWorkItemStoryMarkdown({
      thread_locator: options.threadLocator,
      title: options.title,
      milestones: [milestone],
    }),
  );

  return {
    entry_id: `message:${taskId}:${milestone.kind}`,
    kind: "message",
    title: sanitizePublicMarkdown(options.title ?? milestone.title ?? formatMilestoneKind(milestone.kind)),
    status: "proposed",
    thread_locator: options.threadLocator,
    metadata: {
      schema_version: "runx.outbox-entry.work-item-story.v1",
      workflow,
      milestone_kind: milestone.kind,
      body_markdown: bodyMarkdown,
      updated_at: options.updatedAt,
      control: {
        workflow,
        lane: milestone.kind,
      },
    },
  };
}

export function sanitizePublicMarkdown(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, "$1=[secret]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[secret]")
    .replace(/\b([A-Z][A-Z0-9_]*=)(?:\/Users|\/home|\/var|\/private|\/tmp|[A-Za-z]:\\)[^\s`)]+/g, "$1[local-path]")
    .replace(/(?:\/Users|\/home|\/var|\/private|\/tmp)\/[^\s`)]+/g, "[local-path]")
    .replace(/[A-Za-z]:\\[^\s`)]+/g, "[local-path]");
}

function normalizeIdentifierSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length === 0) {
    throw new Error("work item story identifier segment must not be empty.");
  }
  return normalized;
}

function formatMilestoneKind(kind: WorkItemStoryMilestoneKind): string {
  switch (kind) {
    case "intake":
      return "Intake";
    case "triage":
      return "Triage";
    case "spec":
      return "Spec";
    case "build":
      return "Build";
    case "review":
      return "Review";
    case "pull_request":
      return "Pull request";
    case "merge_gate":
      return "Human merge gate";
    case "outcome":
      return "Outcome";
  }
}
