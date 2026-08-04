export function prepareNotification(inputs) {
  const channel = text(inputs.channel);
  const principal = text(inputs.principal);
  const content = object(inputs.content);
  const findings = [];

  if (!/^(#[a-z0-9_-]{1,80}|[CGD][A-Z0-9]{2,}|slack:\/\/[A-Z][A-Z0-9]{2,}\/[CGD][A-Z0-9]{2,})$/u.test(channel)) {
    findings.push({
      code: "slack.channel.invalid",
      message: "channel must be a Slack #name, id, or exact slack:// locator",
    });
  }
  if (!principal) findings.push({ code: "slack.principal.missing", message: "principal is required" });

  const suppliedRef = text(content.content_ref);
  const suppliedDigest = text(content.digest);
  const message = text(content.message);
  const contentMode = message ? "inline" : "reference";
  if (message) {
    if (message.length > 4000) {
      findings.push({ code: "slack.message.too_large", message: "message exceeds 4000 characters" });
    }
  } else if (!suppliedRef || !isDigest(suppliedDigest)) {
    findings.push({
      code: "slack.content.unbound",
      message: "content requires message or content_ref with sha256 digest",
    });
  }

  return {
    notification_admission: {
      principal,
      channel,
      content_mode: contentMode,
      supplied_ref: suppliedRef,
      supplied_digest: suppliedDigest,
      findings,
    },
    digest_input: message,
  };
}

export function bindNotification(inputs) {
  const admission = object(inputs.notification_admission);
  const digestResult = object(inputs.digest_result);
  const findings = Array.isArray(admission.findings) ? [...admission.findings] : [];
  const inline = admission.content_mode === "inline";
  const contentDigest = inline ? text(digestResult.digest) : text(admission.supplied_digest);
  if (!isDigest(contentDigest)) {
    findings.push({ code: "slack.content.digest_missing", message: "native content digest is missing" });
  }
  const contentRef = inline ? `inline:${contentDigest}` : text(admission.supplied_ref);

  return {
    slack_context: {
      decision: findings.length === 0 ? "ready" : "blocked",
      principal: text(admission.principal),
      channel: text(admission.channel),
      content_ref: contentRef,
      content_digest: contentDigest,
      findings,
    },
  };
}

export function finalizeNotification(inputs) {
  const context = object(inputs.slack_context);
  const sendPlan = object(inputs.send_plan);
  const findings = Array.isArray(context.findings) ? [...context.findings] : [];
  if (context.decision === "ready") {
    if (text(sendPlan.decision) !== "ready") {
      findings.push({ code: "slack.send_plan.not_ready", message: "canonical send-as is not ready" });
    }
    if (text(sendPlan.provider?.name) !== "slack") {
      findings.push({ code: "slack.provider.mismatch", message: "send-as provider is not Slack" });
    }
    if (text(sendPlan.channel) !== "chat") {
      findings.push({ code: "slack.channel_kind.mismatch", message: "send-as channel is not chat" });
    }
    if (text(sendPlan.principal?.ref) !== text(context.principal)) {
      findings.push({ code: "slack.principal.mismatch", message: "send-as principal does not match" });
    }
    if (text(sendPlan.audience?.ref) !== text(context.channel)) {
      findings.push({ code: "slack.audience.mismatch", message: "send-as audience does not match" });
    }
    if (text(sendPlan.content?.digest) !== text(context.content_digest)) {
      findings.push({ code: "slack.content.mismatch", message: "send-as content digest does not match" });
    }
  }

  const ready = context.decision === "ready" && findings.length === 0;
  return {
    notify_plan: {
      schema: "runx.notify.v1",
      decision: ready ? "ready_for_provider" : "blocked",
      provider: "slack",
      principal: text(context.principal),
      channel: text(context.channel),
      content_ref: text(context.content_ref),
      content_digest: text(context.content_digest),
      send_plan: sendPlan,
      provider_status: "not_called",
      delivery_status: "not_sent",
      downstream_handoff: ready ? {
        skill: "slack-notify",
        runner: "deliver",
        state: "ready_for_approval",
      } : {},
      validation: { status: ready ? "pass" : "fail", findings },
    },
  };
}

function isDigest(value) {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
