const API_URL = "https://api.nitrosend.com/mcp";
const API_HOST = "api.nitrosend.com";
const READ_OPERATIONS = new Map([
  ["status", "nitro_get_status"],
  ["sender_settings", "nitro_configure_account"],
  ["insights", "nitro_get_insights"],
  ["review_delivery", "nitro_review_delivery"],
  ["review_content", "nitro_review_delivery"],
  ["import_status", "nitro_query"],
  ["compose_campaign_intent", "nitro_compose_campaign"],
  ["validate_campaign_composition", "nitro_compose_campaign"],
  ["billing_status", "nitro_manage_billing"],
  ["billing_plans", "nitro_manage_billing"],
  ["plan_checkout_status", "nitro_manage_billing"],
]);
const ACT_OPERATIONS = new Map([
  ["plan_checkout", "nitro_manage_billing"],
  ["send_transactional", "nitro_send_message"],
  ["configure_sender", "nitro_configure_account"],
  ["control_delivery", "nitro_control_delivery"],
  ["import_contacts", "nitro_import_contacts"],
  ["compose_campaign", "nitro_compose_campaign"],
  ["compose_flow", "nitro_compose_flow"],
  ["manage_template", "nitro_manage_template"],
  ["define_segment", "nitro_define_segment"],
  ["ingest_image", "nitro_ingest"],
]);
const DELIVERY_OPERATIONS = new Set([
  "approve", "reject", "live", "schedule", "pause", "resume", "cancel",
  "archive", "restore", "delete",
]);
const SENSITIVE_KEYS = /authorization|api[_-]?key|bearer|credential|secret|token/iu;
const SECRET_VALUE = /\b(?:nskey|wpkey)_(?:live|test)_[A-Za-z0-9_-]+\b/gu;

export function prepareOperation(inputs) {
  const mode = text(inputs.mode);
  const operation = text(inputs.operation);
  const rawArguments = inputs.arguments;
  const args = record(rawArguments);
  const brandSid = text(inputs.brand_sid);
  const operations = mode === "read" ? READ_OPERATIONS : mode === "act" ? ACT_OPERATIONS : null;
  const blockers = operations
    ? [
        ...(rawArguments !== undefined && !isRecord(rawArguments)
          ? ["arguments must be a JSON object"]
          : []),
        ...validate(mode, operation, args, brandSid),
      ]
    : ["mode must be read or act"];
  const decision = blockers.some((blocker) => blocker.startsWith("refused:"))
    ? "refused"
    : blockers.length > 0
      ? "needs_input"
      : "ready";
  const tool = operations?.get(operation) ?? null;
  const requestId = `nitrosend-${operation || "unknown"}`;
  return {
    operation_plan: {
      decision,
      provider: "nitrosend",
      mode,
      operation: operation || null,
      tool,
      brand_sid: brandSid || null,
      requests: decision === "ready"
        ? [{
            id: requestId,
            method: "POST",
            url: API_URL,
            headers: {
              accept: "application/json, text/event-stream",
              ...(brandSid ? { "x-brand-sid": brandSid } : {}),
            },
            body: {
              jsonrpc: "2.0",
              id: requestId,
              method: "tools/call",
              params: { name: tool, arguments: providerArguments(operation, args) },
            },
          }]
        : [],
      allowed_hosts: [API_HOST],
      auth: { type: "bearer", secret_env: "NITROSEND_API_KEY" },
      blockers: blockers.map((blocker) => blocker.replace(/^refused:/u, "")),
    },
  };
}

export function normalizeOperation(inputs) {
  const plan = record(inputs.operation_plan);
  const execution = record(inputs.http_execution);
  const response = array(execution.responses)[0];
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return { provider_evidence: evidence(plan, "provider_error", null, null, ["Nitrosend returned no HTTP response evidence"]) };
  }
  const status = number(response.status);
  if (response.ok !== true) {
    const authority = status === 401 || status === 403;
    return {
      provider_evidence: evidence(
        plan,
        authority ? "needs_input" : "provider_error",
        response,
        null,
        [authority ? "Nitrosend rejected the configured credential" : `Nitrosend returned HTTP ${status}`],
      ),
    };
  }
  try {
    const result = parseToolContent(providerPayload(response), text(plan.operation));
    const safeResult = redact(result);
    const providerError = safeResult?.error === true || safeResult?.isError === true;
    return {
      provider_evidence: evidence(
        plan,
        providerError ? "provider_error" : "ok",
        response,
        safeResult,
        providerError ? [safeResult?.message || "Nitrosend rejected the operation"] : [],
      ),
    };
  } catch (error) {
    return {
      provider_evidence: evidence(
        plan,
        "provider_error",
        response,
        null,
        [redactText(error instanceof Error ? error.message : String(error))],
      ),
    };
  }
}

export function blockedOperation(inputs) {
  const plan = record(inputs.operation_plan);
  return {
    provider_evidence: evidence(
      plan,
      text(plan.decision) || "needs_input",
      null,
      null,
      array(plan.blockers).map(String),
    ),
  };
}

function validate(mode, operation, args, brandSid) {
  const operations = mode === "read" ? READ_OPERATIONS : ACT_OPERATIONS;
  if (!operations.has(operation)) {
    return [`operation must be one of: ${[...operations.keys()].join(", ")}`];
  }
  if (mode === "read" && ["billing_status", "billing_plans"].includes(operation)) {
    if (Object.keys(args).length > 0) {
      return [`refused:${operation} does not accept provider arguments`];
    }
  }
  if (mode === "read" && operation === "plan_checkout_status") {
    const allowed = new Set(["purchase_id"]);
    const unexpected = Object.keys(args).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      return [`refused:plan_checkout_status received unsupported fields: ${unexpected.join(", ")}`];
    }
    if (!positiveInteger(args.purchase_id)) {
      return ["plan_checkout_status requires arguments.purchase_id"];
    }
  }
  if (mode === "act" && operation === "plan_checkout") {
    const allowed = new Set(["plan_id", "confirm", "idempotency_key"]);
    const unexpected = Object.keys(args).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      return [`refused:plan_checkout received unsupported fields: ${unexpected.join(", ")}`];
    }
    if (!positiveInteger(args.plan_id) || args.confirm !== true || !text(args.idempotency_key)) {
      return ["plan_checkout requires a positive plan_id, approved confirm=true, and stable idempotency_key"];
    }
  }
  if (["sender_settings", "configure_sender"].includes(operation) && !brandSid) {
    return ["refused:sender settings require an explicit brand_sid"];
  }
  if (mode === "read" && operation === "sender_settings" && Object.keys(args).length > 0) {
    return ["sender_settings does not accept provider arguments"];
  }
  if (mode === "act" && operation === "configure_sender") {
    const allowed = new Set([
      "from_name",
      "from_email",
      "reply_to",
      "test_email_recipients",
    ]);
    const unexpected = Object.keys(args).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      return [`configure_sender received unsupported fields: ${unexpected.join(", ")}`];
    }
    if (
      !text(args.from_name) ||
      !email(args.from_email) ||
      !email(args.reply_to) ||
      !Array.isArray(args.test_email_recipients) ||
      args.test_email_recipients.length > 5 ||
      args.test_email_recipients.some((recipient) => !email(recipient))
    ) {
      return [
        "configure_sender requires from_name, valid from_email/reply_to values, and at most five valid test recipients",
      ];
    }
  }
  if (mode === "read" && operation === "insights") {
    const scopes = ["account", "flow", "campaign", "message"];
    if (!scopes.includes(args.scope)) return [`arguments.scope must be one of: ${scopes.join(", ")}`];
    if (args.scope !== "account" && !positiveInteger(args.entity_id)) {
      return [`arguments.entity_id is required for ${args.scope} insights`];
    }
  }
  if (mode === "read" && operation === "review_delivery") {
    if (!["template", "flow", "campaign"].includes(args.target_type) || !positiveInteger(args.target_id)) {
      return ["review_delivery requires a valid target_type and integer target_id"];
    }
    if (args.target_type === "flow" && !positiveInteger(args.revision_id)) {
      return ["review_delivery requires arguments.revision_id for flows"];
    }
  }
  if (mode === "read" && operation === "review_content") {
    const keys = Object.keys(args);
    const unexpected = keys.filter((key) => !["subject", "html"].includes(key));
    if (unexpected.length > 0) {
      return [`review_content received unsupported fields: ${unexpected.join(", ")}`];
    }
    if (typeof args.subject !== "string" || utf8Bytes(args.subject) > 998 ||
        typeof args.html !== "string" || utf8Bytes(args.html) < 1 ||
        utf8Bytes(args.html) > 262_144) {
      return ["review_content requires a UTF-8 subject up to 998 bytes and HTML between 1 and 262144 bytes"];
    }
  }
  if (mode === "read" && operation === "import_status" && !positiveInteger(args.import_id)) {
    return ["import_status requires arguments.import_id"];
  }
  if (mode === "read" && ["compose_campaign_intent", "validate_campaign_composition"].includes(operation)) {
    const expectedMode = operation === "compose_campaign_intent" ? "intent" : "validate";
    if (args.composition_mode !== expectedMode) {
      return [`${operation} requires arguments.composition_mode=${expectedMode}`];
    }
    const forbidden = [
      "audience", "scheduled_at", "confirm", "campaign_id", "mode",
      "approval", "activate", "activation", "send", "operation",
      ...(operation === "compose_campaign_intent" ? ["idempotency_key"] : []),
    ].filter((key) => Object.hasOwn(args, key));
    if (forbidden.length > 0) {
      return [`refused:${operation} cannot receive stateful fields: ${forbidden.join(", ")}`];
    }
    if (operation === "compose_campaign_intent" && args.contract_id !== undefined) {
      return ["compose_campaign_intent must not receive arguments.contract_id"];
    }
    if (operation === "validate_campaign_composition" && !text(args.contract_id)) {
      return ["validate_campaign_composition requires arguments.contract_id"];
    }
    if (operation === "validate_campaign_composition" && !text(args.body) && !Array.isArray(args.sections)) {
      return ["validate_campaign_composition requires arguments.body or arguments.sections"];
    }
  }
  if (mode === "act" && operation === "send_transactional") {
    if (!["email", "sms"].includes(args.channel) || !text(args.to)) {
      return ["send_transactional requires channel email or sms and one recipient"];
    }
    if (args.dry_run !== true && !text(args.idempotency_key)) {
      return ["refused:a real transactional send requires arguments.idempotency_key"];
    }
  }
  if (mode === "act" && operation === "control_delivery") {
    if (!["flow", "campaign"].includes(args.target_type) || !positiveInteger(args.target_id) || !DELIVERY_OPERATIONS.has(args.operation)) {
      return ["control_delivery requires a valid target_type, integer target_id, and lifecycle operation"];
    }
    if (
      args.target_type === "flow" &&
      ["approve", "reject", "live"].includes(args.operation) &&
      !positiveInteger(args.revision_id)
    ) {
      return [`control_delivery requires arguments.revision_id for flow ${args.operation}`];
    }
    if (args.operation === "schedule" && !text(args.scheduled_at)) {
      return ["scheduled campaign delivery requires arguments.scheduled_at"];
    }
    if (["live", "schedule"].includes(args.operation) && args.target_type === "campaign" && !text(args.idempotency_key)) {
      return ["refused:live or scheduled campaign delivery requires arguments.idempotency_key"];
    }
  }
  if (mode === "act" && operation === "import_contacts") {
    if (!text(args.source_id) || !text(args.consent_basis)) {
      return ["contact imports require arguments.source_id and arguments.consent_basis"];
    }
    if (/purchased|scraped|data\s*broker/iu.test(args.consent_basis)) {
      return ["refused:purchased, scraped, and data-broker contact sources are not permitted"];
    }
    if (args.dry_run !== true && !text(args.idempotency_key)) {
      return ["refused:a real contact import requires arguments.idempotency_key"];
    }
  }
  if (mode === "act" && operation === "ingest_image") {
    const allowed = new Set(["image_url", "description", "filename"]);
    const unexpected = Object.keys(args).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      return [`ingest_image received unsupported fields: ${unexpected.join(", ")}`];
    }
    if (!/^https?:\/\/[^\s]+$/iu.test(text(args.image_url)) || !text(args.description)) {
      return ["ingest_image requires one public http/https image_url and an honest description"];
    }
  }
  return [];
}

function utf8Bytes(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff &&
             index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 &&
             value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function providerArguments(operation, args) {
  if (operation === "billing_status") return { operation: "status" };
  if (operation === "billing_plans") return { operation: "plans" };
  if (operation === "plan_checkout_status") {
    return {
      operation: "checkout_status",
      params: { purchase_id: Number(args.purchase_id) },
    };
  }
  if (operation === "plan_checkout") {
    return {
      operation: "checkout",
      params: { plan_id: Number(args.plan_id), confirm: true },
      idempotency_key: args.idempotency_key,
    };
  }
  if (operation === "sender_settings") return {};
  if (operation === "compose_campaign_intent") {
    return { ...args, composition_mode: "intent" };
  }
  if (operation === "validate_campaign_composition") {
    const { idempotency_key: _idempotencyKey, ...validationArgs } = args;
    return { ...validationArgs, composition_mode: "validate", validate_only: true };
  }
  if (operation === "import_status") {
    return { entity: "imports", filters: { id: Number(args.import_id) }, page: 1, per: 1 };
  }
  if (operation === "ingest_image") {
    return {
      kind: "image",
      image_url: args.image_url,
      description: args.description,
      ...(text(args.filename) ? { filename: args.filename } : {}),
    };
  }
  if (operation !== "import_contacts") return args;
  const { source_id: sourceId, consent_basis: _consentBasis, ...providerArgs } = args;
  if (Array.isArray(providerArgs.records)) {
    providerArgs.records = providerArgs.records.map((entry) => {
      const contact = record(entry);
      return { ...contact, source: contact.source || sourceId };
    });
  }
  return providerArgs;
}

function providerPayload(response) {
  if (response.json && typeof response.json === "object" && !Array.isArray(response.json)) {
    return response.json;
  }
  const body = text(response.body);
  if (!body) throw new Error("Nitrosend returned an empty MCP response");
  if (body.startsWith("{")) return JSON.parse(body);
  const payloads = body
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
  if (payloads.length === 0) throw new Error("Nitrosend returned an invalid MCP event stream");
  return JSON.parse(payloads.at(-1));
}

function parseToolContent(payload, operation) {
  if (payload.error) {
    const message = text(payload.error.message) || "Nitrosend MCP request failed";
    const detail = text(payload.error.data);
    throw new Error(detail && detail !== message ? `${message}: ${detail}` : message);
  }
  const content = payload.result?.content;
  if (!Array.isArray(content)) return providerResult(payload.result ?? {});
  const value = content.find((item) => item?.type === "text")?.text;
  if (typeof value !== "string") return providerResult(payload.result ?? {});
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { message: value };
  }
  if (isRecord(parsed) && parsed.meta?.tool && Object.hasOwn(parsed, "result")) {
    const result = record(parsed.result);
    if (operation === "ingest_image") {
      const { signed_id: _signedId, direct_upload: _directUpload, ...publicResult } = result;
      return publicResult;
    }
    if (!["sender_settings", "configure_sender"].includes(operation)) {
      return result;
    }
    const sender = record(result.sender);
    const currentBrand = record(parsed.meta.current_brand);
    return {
      ...result,
      current_brand: parsed.meta.current_brand ?? null,
      sender_settings: {
        brand_sid: text(currentBrand.sid) || null,
        from_name: text(sender.from_name) || null,
        from_email: text(sender.from_email) || null,
        reply_to: text(sender.reply_to) || null,
        test_email_recipients: Array.isArray(result.test_email_recipients)
          ? result.test_email_recipients
          : [],
      },
    };
  }
  return providerResult(parsed);
}

function providerResult(value) {
  if (isRecord(value)) return value;
  throw new Error("Nitrosend returned a non-object tool result");
}

function evidence(plan, decision, response, result, blockers) {
  return {
    decision,
    provider: "nitrosend",
    mode: text(plan.mode),
    operation: plan.operation ?? null,
    tool: plan.tool ?? null,
    provider_ref: providerReference(text(plan.operation), result),
    result,
    evidence: response
      ? {
          request_id: text(response.id),
          http_status: number(response.status),
          body_digest: text(response.body_digest),
          credential_material: "redacted",
        }
      : null,
    blockers,
  };
}

function providerReference(operation, result) {
  const data = result?.data ?? result;
  const id = data?.id ?? data?.message_id ?? data?.import_id ?? data?.target_id ?? data?.campaign_id ?? data?.flow_id;
  return id === undefined || id === null ? null : `nitrosend:${operation}:${id}`;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_KEYS.test(key) ? "[REDACTED]" : redact(child),
    ]));
  }
  return typeof value === "string" ? redactText(value) : value;
}

function redactText(value) {
  return String(value).replaceAll(SECRET_VALUE, "[REDACTED]").slice(0, 2_000);
}

function record(value) {
  return isRecord(value) ? value : {};
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function positiveInteger(value) {
  return value !== "" && value !== null && value !== undefined && Number.isInteger(Number(value)) && Number(value) > 0;
}

function email(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(text(value));
}
