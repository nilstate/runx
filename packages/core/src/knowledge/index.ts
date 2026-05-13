export const knowledgePackage = "@runxhq/core/knowledge";

import { RUNX_CONTRACT_IDS } from "@runxhq/contracts";

export const RUNX_SCHEMA_REFS = {
  thread: "https://runx.ai/spec/thread.schema.json",
  outbox_entry: "https://runx.ai/spec/outbox-entry.schema.json",
  thread_decision: "https://runx.ai/spec/thread-decision.schema.json",
  knowledge_entry: "https://runx.ai/spec@runxhq/core/knowledge-entry.schema.json",
  handoff_signal: RUNX_CONTRACT_IDS.handoffSignal,
  handoff_state: RUNX_CONTRACT_IDS.handoffState,
  suppression_record: RUNX_CONTRACT_IDS.suppressionRecord,
} as const;

export {
  type Actor,
  type EvidenceRef,
  type ThreadAdapterDescriptor,
} from "./internal-validators.js";

export {
  type ThreadEntryKind,
  type ThreadDecisionValue,
  type ThreadEntry,
  type ThreadDecision,
  type Thread,
  type ThreadFetchRequest,
  type PushOutboxEntryRequest,
  type PushOutboxEntryResult,
  validateThread,
  validateThreadDecision,
  validateThreadEntry,
  latestDecisionForGate,
  threadAllowsGate,
  summarizeThread,
} from "./thread.js";

export {
  type OutboxEntryKind,
  type OutboxEntryStatus,
  type OutboxEntry,
  type OutboxControlEntrySelector,
  type MaterializedOutboxFile,
  type MaterializeOutboxEntryFilesOptions,
  validateOutboxEntry,
  findOutboxEntry,
  readOutboxEntryControl,
  findLatestOutboxEntry,
  findLatestControlOutboxEntry,
  sortOutboxEntriesByRecency,
  materializeOutboxEntryFiles,
} from "./outbox.js";

export {
  THREAD_STORY_CONTROL_SCHEMA_VERSION,
  THREAD_STORY_MESSAGE_SCHEMA_VERSION,
  type ThreadStorySectionId,
  type ThreadStoryLink,
  type ThreadStorySection,
  type BuildThreadStoryMarkdownOptions,
  type BuildThreadStoryMessageOutboxEntryOptions,
  type ThreadStatusTriageSummary,
  type BuildThreadStatusMarkdownOptions,
  type BuildThreadMilestoneNotificationTextOptions,
  type BuildThreadPullRequestReviewerPacketMarkdownOptions,
  sanitizeThreadStoryText,
  buildThreadStoryMarkdown,
  buildThreadStatusMarkdown,
  buildThreadMilestoneNotificationText,
  buildThreadPullRequestReviewerPacketMarkdown,
  buildThreadStoryMessageOutboxEntry,
} from "./thread-story.js";

export {
  type HandoffSignal,
  type HandoffState,
  type SuppressionRecord,
  type HandoffRef,
  type ReduceHandoffStateRequest,
  validateHandoffSignal,
  validateHandoffState,
  validateSuppressionRecord,
  latestHandoffSignal,
  findActiveSuppressionRecord,
  handoffIsSuppressed,
  reduceHandoffState,
  handoffStateAllowsSignalDisposition,
  handoffStateAllowsOutboxPush,
} from "./handoff.js";

export {
  fetchThreadViaAdapter,
  pushOutboxEntryViaAdapter,
} from "./file-thread.js";

export {
  type LocalKnowledgeEntryKind,
  type LocalKnowledgeReceiptEntry,
  type LocalKnowledgeProjectionEntry,
  type LocalKnowledgeAnswerEntry,
  type LocalKnowledgeArtifactEntry,
  type LocalKnowledgeEntry,
  type LocalKnowledge,
  type IndexReceiptOptions,
  type AddProjectionOptions,
  type LocalKnowledgeStore,
  createFileKnowledgeStore,
} from "./local-store.js";
