import {
  summarizePublicHandoffMarkdown,
} from "./story.mjs";
import { sanitizePublicMarkdown } from "../public_markdown.mjs";

export {
  buildFeedStoryOutboxEntry,
  renderFeedStoryMarkdown,
  summarizePublicHandoffMarkdown,
} from "./story.mjs";
export { sanitizePublicMarkdown } from "../public_markdown.mjs";

export function renderIssueToPrReviewerMarkdown(input) {
  const title = clean(input.title) ?? clean(input.taskId) ?? "Issue-to-PR change";
  const sourceTitle = clean(input.sourceTitle);
  const sourceLocator = clean(input.sourceLocator);
  const sourceSummary = clean(input.sourceSummary);
  const handoff = summarizePublicHandoffMarkdown(input.handoffMarkdown);
  const changedFiles = Array.isArray(input.changedFiles)
    ? input.changedFiles.map((entry) => clean(entry)).filter(Boolean)
    : [];

  return [
    `# ${title}`,
    "",
    "## Source Thread",
    sourceTitle ? `- Source: ${sourceTitle}` : undefined,
    sourceLocator ? `- Locator: ${sourceLocator}` : undefined,
    "",
    "## Source Context",
    sourceSummary ?? "Source context was captured in the governed runx receipt.",
    "",
    "## Changed Files",
    changedFiles.length > 0 ? changedFiles.map((file) => `- \`${file}\``).join("\n") : "- No file list reported.",
    "",
    "## Checks",
    bullet("Governance", clean(input.governanceStatus)),
    bullet("Build", clean(input.checkStatus)),
    bullet("Passed", clean(input.buildPassed)),
    bullet("Failed", clean(input.buildFailed)),
    bullet("Review", clean(input.reviewVerdict)),
    bullet("Blocking findings", clean(input.blockingCount)),
    bullet("Non-blocking findings", clean(input.nonBlockingCount)),
    clean(input.qualityGateSummary) ? `- Quality gate: ${clean(input.qualityGateSummary)}` : undefined,
    "",
    "## scafld Handoff",
    handoff ?? "No public handoff summary was available.",
    "",
    "## Human Merge Gate",
    "Review the diff and merge only after the generated change is acceptable. runx does not auto-merge generated PRs.",
  ].filter((line) => line !== undefined).join("\n");
}

function clean(value) {
  const sanitized = sanitizePublicMarkdown(value)?.trim();
  return sanitized || undefined;
}

function bullet(label, value) {
  return value ? `- ${label}: ${value}` : undefined;
}
