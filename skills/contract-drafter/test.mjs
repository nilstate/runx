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
assert(complete.output.send_proposal?.no_send_performed === true, "runner performs no send");
assert(complete.output.validation?.template_fetch?.fetched_at_runtime === true, "template is fetched from source_ref at runtime");
assert(complete.output.validation?.template_loaded_from_source_ref === true, "validation records source_ref load");
assert(!complete.output.draft_doc.markdown.includes("[["), "all placeholders resolve");

const finalized = finalize(complete.output);
assert(finalized.status === 0, "finalize exits successfully");
assert(finalized.output.send_proposal?.status === "send_as_plan_executed", "send-as plan is executed in graph");
assert(finalized.output.send_as_result?.sealed_in_same_graph === true, "send-as result is bound to the same graph");
assert(finalized.output.send_as_result?.bound_draft_ref === complete.output.draft_ref, "send-as result binds draft ref");
assert(finalized.output.send_as_result?.bound_content_digest === complete.output.draft_doc.content_digest, "send-as result binds draft digest");
assert(finalized.output.validation?.send_as_composed_in_graph === true, "validation records composed send-as step");

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
    { name: "send-as-binding", status: "passed" }
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

function finalize(draftPacket) {
  const sendPlan = {
    decision: "ready",
    action_family: "send-as",
    principal: {
      type: "account",
      ref: "account:contract-review-demo"
    },
    provider: {
      name: "review-queue",
      runtime_path: "review.plan"
    },
    send_class: "contract_review",
    audience: {
      type: "repository_review",
      ref: "RYDE-PLAY/frantic-86-contract-drafter",
      requires_reconfirmation: true
    },
    content: draftPacket.send_proposal.consumer.inputs.content_ref,
    gates: {
      preflight_required: true,
      human_approval_required: true,
      approval_ref: "contract-drafter.send.approval"
    },
    blockers: [],
    provider_actions: ["review.plan"],
    success_checkpoint: {
      milestone: "provider_delivery_required",
      description: "Provider delivery remains outside contract-drafter."
    }
  };
  const result = spawnSync(process.execPath, [join(here, "finalize.mjs")], {
    env: { ...process.env, RUNX_INPUTS_JSON: JSON.stringify({ draft_packet: draftPacket, send_plan: sendPlan }) },
    encoding: "utf8",
  });
  const raw = result.stdout.trim();
  if (!raw) throw new Error(`finalize produced no JSON output: ${result.stderr}`);
  return { status: result.status, output: JSON.parse(raw) };
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}
