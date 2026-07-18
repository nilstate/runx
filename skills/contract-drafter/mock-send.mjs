import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const inputs = readInputs();

try {
  const draft = asObject(inputs.draft_packet, "draft_packet");
  const sendPlan = unwrapSendPlan(inputs.send_plan);
  const proposal = asObject(draft.send_proposal, "draft_packet.send_proposal");
  const contentRef = asObject(proposal.consumer?.inputs?.content_ref, "send_proposal.consumer.inputs.content_ref");

  const errors = [];
  if (draft.status !== "draft_ready") errors.push("draft_packet.status must be draft_ready");
  if (text(sendPlan.decision) !== "ready") errors.push("send_plan.decision must be ready");
  if (text(contentRef.draft_ref) !== text(draft.draft_ref)) errors.push("content_ref.draft_ref must bind draft_ref");
  if (text(contentRef.digest) !== text(draft.draft_doc?.content_digest)) {
    errors.push("content_ref.digest must bind draft content digest");
  }

  if (errors.length > 0) {
    emitPacket({
      schema: "runx.contract_send_delivery.v1",
      status: "refused",
      errors,
      provider_delivery_performed: false,
      readback_verified: false,
    });
    process.exitCode = 2;
  } else {
    const deliveryId = sha256(canonicalJson({
      draft_ref: draft.draft_ref,
      digest: draft.draft_doc.content_digest,
      principal: sendPlan.principal,
      audience: sendPlan.audience,
      provider: sendPlan.provider,
    })).slice(7, 23);
    const readback = {
      provider: "mock-review-queue",
      delivery_id: `mock-delivery:${deliveryId}`,
      draft_ref: draft.draft_ref,
      content_digest: draft.draft_doc.content_digest,
      status: "accepted",
      channel: "review_queue",
      audience: sendPlan.audience,
    };

    emitPacket({
      schema: "runx.contract_send_delivery.v1",
      status: "sent",
      transport: "mock-review-queue",
      mock_transport: true,
      live_external_send_performed: false,
      provider_delivery_performed: true,
      readback_verified: true,
      delivery_id: readback.delivery_id,
      draft_ref: draft.draft_ref,
      content_digest: draft.draft_doc.content_digest,
      provider_actions: ["mock.review_queue.deliver", "mock.review_queue.readback"],
      readback,
      readback_digest: sha256(canonicalJson(readback)),
    });
  }
} catch (error) {
  emitPacket({
    schema: "runx.contract_send_delivery.v1",
    status: "refused",
    errors: [error instanceof Error ? error.message : String(error)],
    provider_delivery_performed: false,
    readback_verified: false,
  });
  process.exitCode = 2;
}

function unwrapSendPlan(value) {
  const object = asObject(value, "send_plan");
  if (object.send_plan && typeof object.send_plan === "object" && !Array.isArray(object.send_plan)) return object.send_plan;
  return object;
}

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) return JSON.parse(readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  if (process.env.RUNX_INPUTS_JSON) return JSON.parse(process.env.RUNX_INPUTS_JSON);
  const fromEnv = {
    draft_packet: parseEnv("RUNX_INPUT_DRAFT_PACKET"),
    send_plan: parseEnv("RUNX_INPUT_SEND_PLAN"),
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

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function emitPacket(value) {
  process.stdout.write(`${JSON.stringify({ send_delivery: value })}\n`);
}
