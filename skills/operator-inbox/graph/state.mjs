import crypto from "node:crypto";

const ACTION_SCHEMA = "runx.operator_inbox.action.v1";
const ACTION_STATUSES = new Set(["open", "waiting", "followed_up", "resolved", "dismissed"]);
const HUMAN_STATUSES = new Set(["waiting", "followed_up", "resolved", "dismissed"]);
const SCAN_STATUSES = new Set(["running", "complete", "truncated", "failed"]);
const TRIAGE_KINDS = new Set(["direct_mention", "operator_selected_query", "imported"]);
const MAX_MESSAGES_PER_PAGE = 20;
const MAX_LOCATORS = 50;

export function actionIdForThread(threadLocator) {
  return `action-${crypto.createHash("sha256").update(text(threadLocator, 500, "thread_locator")).digest("hex")}`;
}

export function planTransition(input) {
  const operation = text(input.operation, 40, "operation");
  const expectedVersion = nonNegativeInteger(input.expectedVersion, "expected_version");
  const observedAt = isoTime(input.observedAt, "observed_at");
  let event;
  let idempotencyKey;

  if (operation === "scan_page") {
    event = scanPageEvent(input.scan, input.messages, observedAt);
    idempotencyKey = `operator-inbox:scan:${event.payload.scan.scan_id}:${event.payload.scan.page_index}:${sha256(event).slice(7, 31)}`;
  } else if (operation === "action_observation") {
    const observedMessage = normalizeMessage(input.message);
    event = actionObservationEvent(input.currentAction, observedMessage, input.triage, observedAt);
    idempotencyKey = `operator-inbox:action:${sha256(observedMessage.message_locator).slice(7, 47)}`;
  } else if (operation === "disposition") {
    event = dispositionEvent(input.currentAction, input.disposition, observedAt);
    idempotencyKey = `operator-inbox:disposition:${event.payload.action.action_id}:${sha256(event).slice(7, 31)}`;
  } else if (operation === "import_action") {
    const action = normalizeAction(input.action);
    event = actionSnapshotEvent(action, "import", action.last_observed_at);
    idempotencyKey = `operator-inbox:import:${action.action_id}:${sha256(action).slice(7, 31)}`;
  } else {
    throw new Error("operator inbox operation must be scan_page, action_observation, disposition, or import_action");
  }

  return {
    effect_family: "operator-inbox",
    operation,
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    event,
  };
}

function scanPageEvent(rawScan, rawMessages, observedAt) {
  const input = object(rawScan, "scan");
  const status = text(input.status, 30, "scan.status");
  if (!SCAN_STATUSES.has(status)) throw new Error(`unsupported operator inbox scan status '${status}'`);
  const messages = Array.isArray(rawMessages) ? rawMessages.map(normalizeMessage) : null;
  if (!messages || messages.length > MAX_MESSAGES_PER_PAGE) {
    throw new Error(`operator inbox messages must be an array of at most ${MAX_MESSAGES_PER_PAGE}`);
  }
  const error = optionalText(input.error, 500, "scan.error");
  if (status === "failed" && !error) throw new Error("failed operator inbox scans require a bounded error");
  const nextCursor = optionalText(input.next_cursor, 500, "scan.next_cursor");
  const startedAt = isoTime(input.started_at ?? observedAt, "scan.started_at");
  const scan = {
    scan_id: text(input.scan_id, 200, "scan.scan_id"),
    provider: text(input.provider, 100, "scan.provider"),
    query_digest: digest(input.query_digest, "scan.query_digest"),
    page_index: positiveInteger(input.page_index, "scan.page_index"),
    status,
    started_at: startedAt,
    updated_at: observedAt,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    ...(error ? { error } : {}),
  };
  return {
    type: `operator_inbox.scan.${status}`,
    effect_family: "operator-inbox",
    operation: "scan_page",
    payload: { observed_at: observedAt, scan, messages },
  };
}

function actionObservationEvent(rawCurrentAction, rawMessage, rawTriage, observedAt) {
  const current = rawCurrentAction ? normalizeAction(rawCurrentAction) : undefined;
  const message = normalizeMessage(rawMessage);
  if (message.author.external_id === message.connected_subject_ref) {
    throw new Error("operator-authored messages cannot create or reopen operator inbox actions");
  }
  const triage = normalizeTriage(rawTriage);
  const actionId = actionIdForThread(message.thread_locator);
  if (current && (current.action_id !== actionId || current.thread_locator !== message.thread_locator)) {
    throw new Error("current_action does not match the observed thread");
  }
  const isNewer = !current || Date.parse(message.occurred_at) > Date.parse(current.latest_message.occurred_at);
  const reopens = Boolean(
    current?.disposition
      && Date.parse(message.occurred_at) > Date.parse(current.disposition.covered_occurrence_at),
  );
  const locators = Array.from(new Set([...(current?.message_locators ?? []), message.message_locator])).slice(-MAX_LOCATORS);
  const action = {
    schema: ACTION_SCHEMA,
    action_id: actionId,
    provider: current?.provider ?? message.provider,
    external_tenant_ref: current?.external_tenant_ref ?? message.external_tenant_ref,
    connected_subject_ref: current?.connected_subject_ref ?? message.connected_subject_ref,
    thread_locator: message.thread_locator,
    requester: current?.requester ?? message.author,
    conversation: isNewer ? message.conversation : current.conversation,
    latest_message: isNewer ? latestMessage(message) : current.latest_message,
    message_locators: locators,
    status: reopens ? "open" : (current?.status ?? "open"),
    disposition: reopens ? undefined : current?.disposition,
    triage: current?.triage ?? triage,
    first_observed_at: current?.first_observed_at ?? observedAt,
    last_observed_at: observedAt,
  };
  return actionSnapshotEvent(action, reopens ? "reopened" : "observed", observedAt);
}

function dispositionEvent(rawCurrentAction, rawDisposition, observedAt) {
  const current = normalizeAction(rawCurrentAction);
  const input = object(rawDisposition, "disposition");
  const status = text(input.status, 30, "disposition.status");
  if (!HUMAN_STATUSES.has(status)) {
    throw new Error("operator inbox human disposition must be waiting, followed_up, resolved, or dismissed");
  }
  const evidenceUrl = optionalHttpsUrl(input.evidence_url);
  const action = {
    ...current,
    status,
    disposition: {
      status,
      actor: text(input.actor, 200, "disposition.actor"),
      reason: text(input.reason, 500, "disposition.reason"),
      at: observedAt,
      covered_occurrence_at: current.latest_message.occurred_at,
      ...(evidenceUrl ? { evidence_url: evidenceUrl } : {}),
    },
    last_observed_at: observedAt,
  };
  return actionSnapshotEvent(action, "disposition", observedAt);
}

function actionSnapshotEvent(rawAction, reason, observedAt) {
  const action = normalizeAction(rawAction);
  return {
    type: `operator_inbox.action.${action.status}`,
    effect_family: "operator-inbox",
    operation: "action_snapshot",
    payload: {
      observed_at: observedAt,
      reason,
      action,
    },
  };
}

function normalizeAction(value) {
  const input = object(value, "action");
  if (input.schema !== ACTION_SCHEMA) throw new Error("operator inbox action has an unsupported schema");
  const status = text(input.status, 30, "action.status");
  if (!ACTION_STATUSES.has(status)) throw new Error(`unsupported operator inbox action status '${status}'`);
  const disposition = input.disposition ? normalizeDisposition(input.disposition) : undefined;
  if (status !== "open" && !disposition) throw new Error("non-open operator inbox actions require a disposition");
  const threadLocator = text(input.thread_locator, 500, "action.thread_locator");
  const actionId = text(input.action_id, 100, "action.action_id");
  if (actionId !== actionIdForThread(threadLocator)) throw new Error("action_id does not match action.thread_locator");
  return {
    schema: ACTION_SCHEMA,
    action_id: actionId,
    provider: text(input.provider, 100, "action.provider"),
    external_tenant_ref: text(input.external_tenant_ref, 300, "action.external_tenant_ref"),
    connected_subject_ref: text(input.connected_subject_ref, 300, "action.connected_subject_ref"),
    thread_locator: threadLocator,
    requester: normalizeAuthor(input.requester),
    conversation: normalizeConversation(input.conversation),
    latest_message: normalizeLatestMessage(input.latest_message),
    message_locators: array(input.message_locators, "action.message_locators").slice(-MAX_LOCATORS).map((locator) => text(locator, 500, "action.message_locator")),
    status,
    ...(disposition ? { disposition } : {}),
    triage: normalizeTriage(input.triage),
    first_observed_at: isoTime(input.first_observed_at, "action.first_observed_at"),
    last_observed_at: isoTime(input.last_observed_at, "action.last_observed_at"),
  };
}

function normalizeTriage(value) {
  const input = object(value, "triage");
  const kind = text(input.kind, 50, "triage.kind");
  if (!TRIAGE_KINDS.has(kind)) throw new Error(`unsupported operator inbox triage kind '${kind}'`);
  return {
    kind,
    reason: text(input.reason, 500, "triage.reason"),
  };
}

function normalizeDisposition(value) {
  const input = object(value, "action.disposition");
  const status = text(input.status, 30, "action.disposition.status");
  if (!HUMAN_STATUSES.has(status)) throw new Error("action disposition has an unsupported status");
  const evidenceUrl = optionalHttpsUrl(input.evidence_url);
  return {
    status,
    actor: text(input.actor, 200, "action.disposition.actor"),
    reason: text(input.reason, 500, "action.disposition.reason"),
    at: isoTime(input.at, "action.disposition.at"),
    covered_occurrence_at: isoTime(input.covered_occurrence_at, "action.disposition.covered_occurrence_at"),
    ...(evidenceUrl ? { evidence_url: evidenceUrl } : {}),
  };
}

function normalizeMessage(value) {
  const input = object(value, "message");
  const context = array(input.context, "message.context").slice(0, 40).map((entry) => {
    const message = object(entry, "message.context entry");
    return {
      relation: message.relation === "before" ? "before" : "after",
      message_locator: text(message.message_locator, 500, "context.message_locator"),
      author: normalizeAuthor(message.author),
      occurred_at: isoTime(message.occurred_at, "context.occurred_at"),
      preview: optionalText(message.preview, 500, "context.preview") ?? "",
    };
  });
  return {
    provider: text(input.provider, 100, "message.provider"),
    external_tenant_ref: text(input.external_tenant_ref, 300, "message.external_tenant_ref"),
    connected_subject_ref: text(input.connected_subject_ref, 300, "message.connected_subject_ref"),
    message_locator: text(input.message_locator, 500, "message.message_locator"),
    thread_locator: text(input.thread_locator, 500, "message.thread_locator"),
    author: normalizeAuthor(input.author),
    conversation: normalizeConversation(input.conversation),
    occurred_at: isoTime(input.occurred_at, "message.occurred_at"),
    preview: optionalText(input.preview, 2_000, "message.preview") ?? "",
    ...(optionalHttpsUrl(input.permalink) ? { permalink: optionalHttpsUrl(input.permalink) } : {}),
    ...(Number.isSafeInteger(input.reply_count) && input.reply_count >= 0 ? { reply_count: input.reply_count } : {}),
    context,
  };
}

function normalizeConversation(value) {
  const input = object(value, "conversation");
  const displayName = optionalText(input.display_name, 300, "conversation.display_name");
  return {
    external_id: text(input.external_id, 300, "conversation.external_id"),
    ...(displayName ? { display_name: displayName } : {}),
    type: text(input.type, 30, "conversation.type"),
  };
}

function normalizeAuthor(value) {
  const input = object(value, "author");
  const displayName = optionalText(input.display_name, 300, "author.display_name");
  return {
    external_id: text(input.external_id, 300, "author.external_id"),
    ...(displayName ? { display_name: displayName } : {}),
  };
}

function normalizeLatestMessage(value) {
  const input = object(value, "latest_message");
  const permalink = optionalHttpsUrl(input.permalink);
  return {
    message_locator: text(input.message_locator, 500, "latest_message.message_locator"),
    occurred_at: isoTime(input.occurred_at, "latest_message.occurred_at"),
    preview: optionalText(input.preview, 2_000, "latest_message.preview") ?? "",
    ...(permalink ? { permalink } : {}),
    ...(Number.isSafeInteger(input.reply_count) && input.reply_count >= 0 ? { reply_count: input.reply_count } : {}),
  };
}

function latestMessage(message) {
  return normalizeLatestMessage(message);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function text(value, max, field) {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u001f]/.test(result)) throw new Error(`${field} is invalid`);
  return result;
}

function optionalText(value, max, field) {
  return value === undefined || value === null ? undefined : text(value, max, field);
}

function isoTime(value, field) {
  const result = text(value, 100, field);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${field} must be ISO-8601`);
  return new Date(result).toISOString();
}

function digest(value, field) {
  const result = text(value, 100, field);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) throw new Error(`${field} must be a sha256 digest`);
  return result;
}

function optionalHttpsUrl(value) {
  if (value === undefined || value === null) return undefined;
  const result = text(value, 2_000, "URL");
  const url = new URL(result);
  if (url.protocol !== "https:") throw new Error("operator inbox URLs must use HTTPS");
  return url.toString();
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
