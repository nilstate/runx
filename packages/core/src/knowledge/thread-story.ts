import { validateOutboxEntry, type OutboxEntry, type OutboxEntryStatus } from "./outbox.js";

export const THREAD_STORY_CONTROL_SCHEMA_VERSION = "runx.thread-story.control.v1";
export const THREAD_STORY_MESSAGE_SCHEMA_VERSION = "runx.outbox-entry.message.v1";

export type ThreadStorySectionId =
  | "initial_issue"
  | "triage_results"
  | "pr_created"
  | "human_merge_gate"
  | "completion_update"
  | string;

export interface ThreadStoryLink {
  readonly label?: string;
  readonly uri: string;
}

export interface ThreadStorySection {
  readonly section_id: ThreadStorySectionId;
  readonly heading?: string;
  readonly summary?: string;
  readonly body?: string;
  readonly bullets?: readonly string[];
  readonly link?: ThreadStoryLink;
}

export interface BuildThreadStoryMarkdownOptions {
  readonly title?: string;
  readonly sections: readonly ThreadStorySection[];
  readonly maxSnapshotChars?: number;
}

export interface BuildThreadStoryMessageOutboxEntryOptions {
  readonly entryId: string;
  readonly threadLocator: string;
  readonly workflow: string;
  readonly lane: string;
  readonly taskId?: string;
  readonly gateId?: string;
  readonly sourceLocator?: string;
  readonly title?: string;
  readonly status?: OutboxEntryStatus;
  readonly story: string | BuildThreadStoryMarkdownOptions;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ThreadStatusTriageSummary {
  readonly lane?: string;
  readonly decision?: string;
  readonly severity?: string;
  readonly summary?: string;
  readonly rationale?: string;
}

export interface BuildThreadStatusMarkdownOptions {
  readonly title?: string;
  readonly state: string;
  readonly summary?: string;
  readonly source?: ThreadStoryLink;
  readonly issue?: ThreadStoryLink;
  readonly pullRequest?: ThreadStoryLink;
  readonly triage?: ThreadStatusTriageSummary;
  readonly scope?: readonly string[];
  readonly validation?: readonly string[];
  readonly risks?: readonly string[];
  readonly nextAction?: string;
  readonly maxChars?: number;
}

export interface BuildThreadMilestoneNotificationTextOptions {
  readonly label?: string;
  readonly state: string;
  readonly summary?: string;
  readonly issue?: ThreadStoryLink;
  readonly pullRequest?: ThreadStoryLink;
  readonly nextAction?: string;
  readonly maxChars?: number;
}

export interface BuildThreadPullRequestReviewerPacketMarkdownOptions {
  readonly title?: string;
  readonly summary?: string;
  readonly source?: ThreadStoryLink;
  readonly issue?: ThreadStoryLink;
  readonly pullRequest?: ThreadStoryLink;
  readonly targetRepo?: string;
  readonly branch?: string;
  readonly base?: string;
  readonly status?: string;
  readonly reviewVerdict?: string;
  readonly checks?: readonly string[];
  readonly risks?: readonly string[];
  readonly handoffReference?: string;
  readonly nextAction?: string;
  readonly maxChars?: number;
}

const DEFAULT_MAX_SNAPSHOT_CHARS = 900;
const DEFAULT_MAX_STATUS_CHARS = 420;

const THREAD_STORY_HEADINGS: Readonly<Record<string, string>> = {
  initial_issue: "Initial Issue",
  triage_results: "Triage Results",
  pr_created: "PR Created",
  human_merge_gate: "Final Human Merge Gate",
  completion_update: "Completion Update",
};

export function sanitizeThreadStoryText(
  value: string | undefined,
  maxChars = DEFAULT_MAX_SNAPSHOT_CHARS,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .trim();
  if (normalized.length === 0) {
    return undefined;
  }
  const limit = Math.max(16, maxChars);
  return normalized.length > limit ? `${normalized.slice(0, limit - 3).trimEnd()}...` : normalized;
}

export function buildThreadStoryMarkdown(options: BuildThreadStoryMarkdownOptions): string {
  const maxChars = options.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS;
  const lines: string[] = [];
  const title = sanitizeThreadStoryText(options.title, 160);
  if (title) {
    lines.push(`# ${title}`, "");
  }

  for (const section of options.sections) {
    const rendered = renderThreadStorySection(section, maxChars);
    if (rendered.length === 0) {
      continue;
    }
    if (lines.length > 0 && lines.at(-1) !== "") {
      lines.push("");
    }
    lines.push(...rendered, "");
  }

  return lines.join("\n").trim();
}

export function buildThreadStatusMarkdown(options: BuildThreadStatusMarkdownOptions): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_STATUS_CHARS;
  const lines: string[] = ["## Runx Status", ""];
  const state = sanitizeThreadStoryText(options.state, 80) ?? "unknown";
  const title = sanitizeThreadStoryText(options.title, 160);
  const summary = sanitizeThreadStoryText(options.summary, maxChars);
  const nextAction = sanitizeThreadStoryText(options.nextAction, maxChars);

  lines.push(...compactLines([
    `State: \`${state}\``,
    title ? `Title: ${title}` : undefined,
    renderThreadStoryLinkLine("Source", options.source),
    renderThreadStoryLinkLine("Issue", options.issue),
    renderThreadStoryLinkLine("PR", options.pullRequest),
  ]));

  if (summary) {
    lines.push("", "## Summary", summary);
  }

  const triageLines = compactLines([
    renderCodeLine("Lane", options.triage?.lane, 80),
    renderCodeLine("Decision", options.triage?.decision, 120),
    renderCodeLine("Severity", options.triage?.severity, 80),
    sanitizeThreadStoryText(options.triage?.summary, maxChars),
    sanitizeThreadStoryText(options.triage?.rationale, maxChars),
  ]);
  if (triageLines.length > 0) {
    lines.push("", "## Triage", ...triageLines);
  }

  appendBullets(lines, "Scope", options.scope, maxChars);
  appendBullets(lines, "Validation", options.validation, maxChars);
  appendBullets(lines, "Risks", options.risks, maxChars);

  if (nextAction) {
    lines.push("", "## Next Action", nextAction);
  }

  return lines.join("\n").trim();
}

export function buildThreadMilestoneNotificationText(
  options: BuildThreadMilestoneNotificationTextOptions,
): string {
  const maxChars = options.maxChars ?? 240;
  const label = sanitizeThreadStoryText(options.label, 80) ?? "Runx";
  const state = sanitizeThreadStoryText(options.state, 80) ?? "unknown";
  const nextAction = sanitizeThreadStoryText(options.nextAction, maxChars);
  return compactLines([
    `${label}: ${state}`,
    sanitizeThreadStoryText(options.summary, maxChars),
    renderThreadStoryLinkLine("Issue", options.issue),
    renderThreadStoryLinkLine("PR", options.pullRequest),
    nextAction ? `Next: ${nextAction}` : undefined,
  ]).join("\n");
}

export function buildThreadPullRequestReviewerPacketMarkdown(
  options: BuildThreadPullRequestReviewerPacketMarkdownOptions,
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_STATUS_CHARS;
  const title = sanitizeThreadStoryText(options.title, 160) ?? "Runx Pull Request";
  const summary = sanitizeThreadStoryText(options.summary, maxChars)
    ?? "Runx prepared this governed change for human review.";
  const status = sanitizeThreadStoryText(options.status, 80);
  const reviewVerdict = sanitizeThreadStoryText(options.reviewVerdict, 80);
  const targetRepo = sanitizeThreadStoryText(options.targetRepo, 160);
  const branch = sanitizeThreadStoryText(options.branch, 160);
  const base = sanitizeThreadStoryText(options.base, 160);
  const handoffReference = sanitizeThreadStoryText(options.handoffReference, maxChars)
    ?? "Full scafld handoff evidence is retained in the draft pull request packet.";
  const nextAction = sanitizeThreadStoryText(options.nextAction, maxChars)
    ?? "Review the PR and merge manually only when the source thread, implementation, and validation evidence line up.";

  const lines: string[] = [
    `# ${title}`,
    "",
    "## Summary",
    summary,
    "",
    "## Review Packet",
    ...compactLines([
      renderThreadStoryLinkLine("Source", options.source),
      renderThreadStoryLinkLine("Issue", options.issue),
      renderThreadStoryLinkLine("PR", options.pullRequest),
      targetRepo ? `Target: \`${targetRepo}\`` : undefined,
      branch || base ? `Branch: \`${branch ?? "unknown"}\` -> \`${base ?? "unknown"}\`` : undefined,
      status ? `Status: \`${status}\`` : undefined,
      reviewVerdict ? `Review: \`${reviewVerdict}\`` : undefined,
    ]),
  ];

  appendBullets(lines, "Checks", options.checks, maxChars);
  appendBullets(lines, "Risks", options.risks, maxChars);

  lines.push(
    "",
    "## Human Merge Gate",
    "Runx has stopped at a reviewable PR. A human reviewer must inspect, approve, and merge manually.",
    "",
    "## Evidence",
    handoffReference,
    "",
    "## Next Action",
    nextAction,
  );

  return lines.join("\n").trim();
}

export function buildThreadStoryMessageOutboxEntry(
  options: BuildThreadStoryMessageOutboxEntryOptions,
): OutboxEntry {
  const metadata = pruneRecord(options.metadata);
  const bodyMarkdown = typeof options.story === "string"
    ? sanitizeThreadStoryText(options.story, 16_000)
    : buildThreadStoryMarkdown(options.story);

  if (!bodyMarkdown) {
    throw new Error("thread story body_markdown is required.");
  }

  return validateOutboxEntry({
    entry_id: options.entryId,
    kind: "message",
    title: options.title,
    status: options.status ?? "proposed",
    thread_locator: options.threadLocator,
    metadata: pruneRecord({
      ...metadata,
      schema_version: THREAD_STORY_MESSAGE_SCHEMA_VERSION,
      channel: "thread_story",
      body_markdown: bodyMarkdown,
      control: pruneRecord({
        ...pruneRecord(asRecord(metadata?.control)),
        schema_version: THREAD_STORY_CONTROL_SCHEMA_VERSION,
        workflow: options.workflow,
        lane: options.lane,
        task_id: options.taskId,
        gate_id: options.gateId,
        source_locator: options.sourceLocator,
      }),
    }),
  });
}

function renderThreadStorySection(
  section: ThreadStorySection,
  maxChars: number,
): readonly string[] {
  const heading = sanitizeThreadStoryText(
    section.heading ?? THREAD_STORY_HEADINGS[section.section_id] ?? section.section_id,
    120,
  );
  if (!heading) {
    return [];
  }
  const lines = [`## ${heading}`];
  const summary = sanitizeThreadStoryText(section.summary, maxChars);
  if (summary) {
    lines.push("", summary);
  }
  const body = sanitizeThreadStoryText(section.body, maxChars);
  if (body) {
    lines.push("", ...body.split("\n").map((line) => line.length > 0 ? `> ${line}` : ">"));
  }
  const bullets = section.bullets
    ?.map((bullet) => sanitizeThreadStoryText(bullet, maxChars))
    .filter((bullet): bullet is string => Boolean(bullet));
  if (bullets && bullets.length > 0) {
    lines.push("", ...bullets.map((bullet) => `- ${bullet}`));
  }
  const link = renderThreadStoryLink(section.link);
  if (link) {
    lines.push("", link);
  }
  return lines;
}

function renderThreadStoryLink(link: ThreadStoryLink | undefined): string | undefined {
  if (!link) {
    return undefined;
  }
  const uri = sanitizeThreadStoryText(link.uri, 2_000);
  if (!uri) {
    return undefined;
  }
  const label = sanitizeThreadStoryText(link.label, 80) ?? "Open";
  return `[${label}](${uri})`;
}

function renderThreadStoryLinkLine(label: string, link: ThreadStoryLink | undefined): string | undefined {
  const rendered = renderThreadStoryLink(link);
  return rendered ? `${label}: ${rendered}` : undefined;
}

function renderCodeLine(label: string, value: string | undefined, maxChars: number): string | undefined {
  const text = sanitizeThreadStoryText(value, maxChars);
  return text ? `${label}: \`${text}\`` : undefined;
}

function appendBullets(
  lines: string[],
  heading: string,
  values: readonly string[] | undefined,
  maxChars: number,
): void {
  const items = values
    ?.map((value) => sanitizeThreadStoryText(value, maxChars))
    .filter((value): value is string => Boolean(value));
  if (!items || items.length === 0) {
    return;
  }
  lines.push("", `## ${heading}`, ...items.map((item) => `- ${item}`));
}

function compactLines(values: readonly (string | undefined)[]): string[] {
  return values.filter((value): value is string => Boolean(value && value.trim().length > 0));
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function pruneRecord(value: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined {
  if (!value) {
    return undefined;
  }
  const entries = Object.entries(value)
    .filter(([, nested]) => nested !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
