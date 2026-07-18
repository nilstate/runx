import { readFileSync } from "node:fs";

const inputs = readInputs();

try {
  const objective = requireText(inputs.objective, "objective");
  const principalRef = requireText(inputs.principal, "principal");
  const provider = asObject(inputs.provider_context, "provider_context");
  const audience = asObject(inputs.audience, "audience");
  const content = asObject(inputs.content_ref, "content_ref");
  const consentBasis = requireText(inputs.consent_basis, "consent_basis");
  const operatorContext = requireText(inputs.operator_context, "operator_context");
  const providerName = requireText(provider.name, "provider_context.name");
  const runtimePath = requireText(provider.runtime_path, "provider_context.runtime_path");

  emit({
    send_plan: {
      decision: "ready",
      action_family: "send-as",
      objective,
      principal: {
        type: principalRef.split(":")[0] || "account",
        ref: principalRef,
      },
      provider: {
        name: providerName,
        account_ref: text(provider.account_ref) || "provider-account:mock-review-queue",
        runtime_path: runtimePath,
      },
      send_class: "contract_review",
      channel: "other",
      audience: {
        ...audience,
        requires_reconfirmation: false,
      },
      content: {
        draft_ref: requireText(content.draft_ref, "content_ref.draft_ref"),
        digest: requireText(content.digest, "content_ref.digest"),
        subject_or_title: requireText(content.subject_or_title, "content_ref.subject_or_title"),
      },
      gates: {
        preflight_required: true,
        human_approval_required: false,
        approval_ref: "contract-drafter.mock-send.allowed",
      },
      blockers: [],
      provider_actions: ["mock.review_queue.deliver", "mock.review_queue.readback"],
      evidence_refs: [content.draft_ref, content.digest],
      consent_basis: consentBasis,
      operator_context: operatorContext,
      source_skill_contract: "runx/send-as@0.1.4",
      success_checkpoint: {
        milestone: "mock_provider_delivery_ready",
        description: "The parent graph must execute deterministic mock provider delivery and readback before sealing.",
      },
    },
  });
} catch (error) {
  emit({
    send_plan: {
      decision: "refused",
      action_family: "send-as",
      blockers: [error instanceof Error ? error.message : String(error)],
      provider_actions: [],
      evidence_refs: [],
    },
  });
  process.exitCode = 2;
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  const fromEnv = {
    objective: parseEnv("RUNX_INPUT_OBJECTIVE"),
    principal: parseEnv("RUNX_INPUT_PRINCIPAL"),
    provider_context: parseEnv("RUNX_INPUT_PROVIDER_CONTEXT"),
    audience: parseEnv("RUNX_INPUT_AUDIENCE"),
    content_ref: parseEnv("RUNX_INPUT_CONTENT_REF"),
    consent_basis: parseEnv("RUNX_INPUT_CONSENT_BASIS"),
    operator_context: parseEnv("RUNX_INPUT_OPERATOR_CONTEXT"),
  };
  if (Object.values(fromEnv).some((value) => value !== undefined)) return fromEnv;
  return JSON.parse(readFileSync(0, "utf8"));
}

function parseEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireText(value, label) {
  const result = text(value);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
