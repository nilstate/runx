import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const complete = runFixture("complete-draft.json");
assert(complete.status === 0, "complete fixture exits successfully");
assert(complete.output.status === "draft_ready", "complete fixture is draft_ready");
assert(complete.output.draft_doc?.delivery_status === "not_sent", "draft remains unsent");
assert(Array.isArray(complete.output.deviations) && complete.output.deviations.length === 4, "four deviations are visible");
assert(complete.output.deviations.every((item) => item.clause && item.term && item.baseline && item.proposed_change), "each deviation is grounded");
assert(complete.output.send_proposal?.consumer?.skill === "runx/send-as", "proposal names send-as consumer");
assert(complete.output.send_proposal?.consumer?.runner === "plan", "proposal names send-as plan runner");
assert(complete.output.send_proposal?.gate?.approved === false, "proposal is not pre-approved");
assert(!Object.prototype.hasOwnProperty.call(complete.output.send_proposal, "provider_delivery_performed"), "provider delivery is only recorded after mock provider step");
assert(complete.output.validation?.template_fetch?.fetched_at_runtime === true, "template is fetched from source_ref at runtime");
assert(complete.output.validation?.template_loaded_from_source_ref === true, "validation records source_ref load");
assert(!complete.output.draft_doc.markdown.includes("[["), "all placeholders resolve");

const delivered = mockSend(complete.output);
assert(delivered.status === 0, "mock send exits successfully");
assert(delivered.output.send_delivery?.status === "sent", "mock provider send is executed");
assert(delivered.output.send_delivery?.provider_delivery_performed === true, "mock provider delivery is recorded");
assert(delivered.output.send_delivery?.readback_verified === true, "mock provider readback is verified");
assert(delivered.output.send_delivery?.draft_ref === complete.output.draft_ref, "mock delivery binds draft ref");
assert(delivered.output.send_delivery?.content_digest === complete.output.draft_doc.content_digest, "mock delivery binds content digest");

const finalized = finalize(complete.output, delivered.output.send_delivery);
assert(finalized.status === 0, "finalize exits successfully");
assert(finalized.output.send_proposal?.status === "mock_provider_sent", "send-as plan is consumed by mock provider");
assert(finalized.output.send_as_result?.sealed_in_same_graph === true, "send-as result is bound to the same graph");
assert(finalized.output.send_as_result?.bound_draft_ref === complete.output.draft_ref, "send-as result binds draft ref");
assert(finalized.output.send_as_result?.bound_content_digest === complete.output.draft_doc.content_digest, "send-as result binds draft digest");
assert(finalized.output.validation?.send_as_composed_in_graph === true, "validation records composed send-as step");
assert(finalized.output.validation?.provider_delivery_performed === true, "validation records provider delivery");
assert(finalized.output.validation?.provider_readback_verified === true, "validation records provider readback");

const repeat = runFixture("complete-draft.json");
assert(repeat.status === 0, "repeat fixture exits successfully");
assert(JSON.stringify(repeat.output) === JSON.stringify(complete.output), "output is deterministic");

const refused = runFixture("missing-payment-term.json");
assert(refused.status === 0, "missing term seals a refusal without infrastructure failure");
assert(refused.output.status === "refused", "missing term is refused");
assert(refused.output.draft_doc === null, "refusal emits no draft");
assert(Array.isArray(refused.output.deviations) && refused.output.deviations.length === 0, "refusal emits no deviations packet");
assert(refused.output.send_proposal === null, "refusal emits no proposal");
assert(refused.output.validation.errors.includes("terms.payment_terms is required"), "refusal identifies payment_terms");

const strictRefusal = runFixture("missing-payment-term.json", ["--fail-on-refusal"]);
assert(strictRefusal.status === 2, "refusal_check exits with a failure status");
assert(strictRefusal.output.draft_doc === null, "refusal_check emits no draft");
assert(strictRefusal.output.send_proposal === null, "refusal_check emits no proposal");

process.stdout.write(`${JSON.stringify({
  ok: true,
  cases: [
    { name: "complete-draft", status: "passed", draft_ref: complete.output.draft_ref, deviations: complete.output.deviations.length },
    { name: "missing-payment-term", status: "passed", refusal: "terms.payment_terms is required" },
    { name: "deterministic-repeat", status: "passed" },
    { name: "strict-refusal", status: "passed" },
    { name: "send-as-binding", status: "passed" },
    { name: "mock-provider-delivery", status: "passed", delivery_id: delivered.output.send_delivery.delivery_id }
  ]
}, null, 2)}\n`);

function runFixture(name, args = []) {
  const input = JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
  const result = spawnSync(process.execPath, [join(here, "run.mjs"), ...args], {
    env: { ...process.env, RUNX_INPUTS_JSON: JSON.stringify(input) },
    encoding: "utf8",
  });
  const raw = result.stdout.trim();
  if (!raw) throw new Error(`${name} produced no JSON output: ${result.stderr}`);
  return { status: result.status, output: JSON.parse(raw) };
}

function sendPlanFor(draftPacket) {
  return {
    decision: "ready",
    action_family: "send-as",
    principal: {
      type: "account",
      ref: "account:contract-review-demo"
    },
    provider: {
      name: "mock-review-queue",
      account_ref: "provider-account:contract-review-demo",
      runtime_path: "mock.review_queue.deliver"
    },
    send_class: "contract_review",
    channel: "other",
    audience: {
      type: "repository_review",
      ref: "RYDE-PLAY/frantic-86-contract-drafter",
      requires_reconfirmation: false
    },
    content: draftPacket.send_proposal.consumer.inputs.content_ref,
    gates: {
      preflight_required: true,
      human_approval_required: false,
      approval_ref: "contract-drafter.mock-send.allowed"
    },
    blockers: [],
    provider_actions: ["mock.review_queue.deliver", "mock.review_queue.readback"],
    success_checkpoint: {
      milestone: "mock_provider_delivery_ready",
      description: "A deterministic mock provider delivery and readback must run before the graph seals."
    }
  };
}

function mockSend(draftPacket) {
  const result = spawnSync(process.execPath, [join(here, "mock-send.mjs")], {
    env: { ...process.env, RUNX_INPUTS_JSON: JSON.stringify({ draft_packet: draftPacket, send_plan: sendPlanFor(draftPacket) }) },
    encoding: "utf8",
  });
  const raw = result.stdout.trim();
  if (!raw) throw new Error(`mock-send produced no JSON output: ${result.stderr}`);
  return { status: result.status, output: JSON.parse(raw) };
}

function finalize(draftPacket, sendDelivery) {
  const sendPlan = {
    ...sendPlanFor(draftPacket),
    content: draftPacket.send_proposal.consumer.inputs.content_ref,
  };
  const result = spawnSync(process.execPath, [join(here, "finalize.mjs")], {
    env: { ...process.env, RUNX_INPUTS_JSON: JSON.stringify({ draft_packet: draftPacket, send_plan: sendPlan, send_delivery: sendDelivery }) },
    encoding: "utf8",
  });
  const raw = result.stdout.trim();
  if (!raw) throw new Error(`finalize produced no JSON output: ${result.stderr}`);
  return { status: result.status, output: JSON.parse(raw) };
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}
