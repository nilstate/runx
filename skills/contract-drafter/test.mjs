import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
assert(complete.output.send_proposal?.gate?.human_approval_required === true, "provider delivery remains approval-gated outside contract-drafter");
assert(complete.output.send_proposal?.provider_action === null, "contract-drafter does not select a provider action");
assert(complete.output.send_proposal?.live_external_send_performed === false, "contract-drafter performs no live send");
assert(!Object.prototype.hasOwnProperty.call(complete.output.send_proposal, "provider_delivery_performed"), "proposal does not claim provider delivery");
assert(complete.output.send_as_result === null, "contract packet does not embed a send-as result");
assert(complete.output.validation?.template_fetch?.fetched_at_runtime === true, "template is fetched from source_ref at runtime");
assert(complete.output.validation?.template_loaded_from_source_ref === true, "validation records source_ref load");
assert(complete.output.validation?.send_as_canonical_skill === "runx/send-as", "validation records canonical send-as target");
assert(complete.output.validation?.provider_delivery_outside_contract_drafter === true, "validation records no-send boundary");
assert(!complete.output.draft_doc.markdown.includes("[["), "all placeholders resolve");
assert(!existsSync(join(here, "graph", "send-as", "X.yaml")), "package has no local send-as namesake");
assert(!existsSync(join(here, "mock-send.mjs")), "package has no local provider send adapter");

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
    { name: "canonical-send-as-proposal", status: "passed" },
    { name: "no-provider-delivery-in-contract-drafter", status: "passed" }
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

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}
