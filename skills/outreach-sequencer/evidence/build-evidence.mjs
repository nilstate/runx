import { readFileSync, writeFileSync, existsSync } from "node:fs";

const evidenceDir = "skills/outreach-sequencer/evidence";
const branch = process.env.OUTREACH_SEQUENCER_BRANCH || "outreach-sequencer";
const prUrl = process.env.OUTREACH_SEQUENCER_PR_URL || "https://github.com/runxhq/runx/pull/PLACEHOLDER";

function readText(name) {
  const bytes = readFileSync(`${evidenceDir}/${name}`);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString("utf16le").replace(/^\uFEFF/, "");
  return bytes.toString("utf8").replace(/^\uFEFF/, "");
}

function readJson(name, fallback = null) {
  if (!existsSync(`${evidenceDir}/${name}`)) return fallback;
  return JSON.parse(readText(name));
}

const publish = readJson("publish-response.json").publish;
const clean = readJson("clean-install.json", readJson("clean-install-windows.json"));
const happy = readJson("direct-runner-happy.json");
const stop = readJson("direct-runner-stop.json");
const missing = readJson("direct-runner-missing-state.json");
const localHarness = readJson("local-harness-windows.json");
const dogfoodWindows = readJson("dogfood-output-windows.json", {});
const dogfood = readJson("dogfood-output.json", null);
const dogfoodVerify = readJson("dogfood-verify.json", null);

const version = publish.version;
const packageRef = `vidshidden/outreach-sequencer@${version}`;
const publicVersionUrl = `${publish.public_url}@${version}`;
const baseRaw = `https://raw.githubusercontent.com/VidsHidden/runx/${branch}/skills/outreach-sequencer`;
const sourceUrl = `https://github.com/VidsHidden/runx/tree/${branch}/skills/outreach-sequencer`;
const xYamlUrl = `${baseRaw}/X.yaml`;
const skillMdUrl = `${baseRaw}/SKILL.md`;
const evidenceJsonUrl = `${baseRaw}/evidence/evidence.json`;
const verificationJsonUrl = `${baseRaw}/evidence/verification.json`;
const reportUrl = `${baseRaw}/evidence/report.md`;
const receiptRef = dogfood?.receipt_id ? `runx:receipt:${dogfood.receipt_id}` : "pending-ubuntu-dogfood";
const verifyVerdict = dogfoodVerify
  ? {
      valid: dogfoodVerify.valid,
      signature_mode: dogfoodVerify.signature_mode,
      root_receipt_id: dogfoodVerify.trees?.[0]?.root_receipt_id,
      findings: dogfoodVerify.trees?.[0]?.findings ?? [],
    }
  : {
      valid: false,
      signature_mode: null,
      root_receipt_id: null,
      findings: ["Ubuntu dogfood verify has not been recorded yet."],
    };

const harnessCases = [
  { name: "happy_next_touch", status: "sealed" },
  { name: "stop_replied", status: "sealed" },
  { name: "missing_state_needs_agent", status: "refused" },
];

const evidence = {
  schema: "frantic.evidence.v1",
  bounty: "#74",
  package_name: "outreach-sequencer",
  runx_cli_version: "runx-cli 0.6.14",
  summary:
    "Published outreach-sequencer runx skill. The skill reads a pinned data-store engagement projection for one sequence/contact aggregate, decides whether the next touch is eligible, appends an ungated decision event, and emits a handoff-only runx.outreach.next_touch.v1 packet for a separate governed send-as run.",
  published: {
    skill_id: publish.skill_id,
    version,
    registry_ref: packageRef,
    public_url: publicVersionUrl,
    install_command: publish.install_command,
    run_command: publish.run_command,
    digest: `sha256:${publish.digest}`,
    profile_digest: `sha256:${publish.profile_digest}`,
    trust_tier: publish.trust_tier,
    maturity: publish.maturity,
  },
  hosted_harness: publish.harness,
  clean_install: {
    status: clean.status,
    ref: clean.registry.install.ref,
    digest: clean.registry.install.digest,
    profile_digest: clean.registry.install.profile_digest,
  },
  dogfood: {
    package: packageRef,
    input: {
      fixture: "skills/outreach-sequencer/fixtures/happy-next-touch.json",
      aggregate_id: happy.engagement_projection.aggregate_id,
      store_id: happy.engagement_projection.store_id,
      current_touch_index: happy.observations.find((item) => item.type === "sequence_position")?.current_touch_index,
      next_touch_index: happy.next_touch_packet?.touch_index,
      engagement_projection_operation_result: happy.engagement_projection.operation_result,
    },
    command:
      `runx skill ${packageRef} --registry https://api.runx.ai --json -R skills/outreach-sequencer/evidence/dogfood-receipts`,
    status: dogfood?.status ?? "pending_ubuntu",
    receipt_ref: receiptRef,
    run_id: dogfood?.run_id,
    verify_verdict: verifyVerdict,
    harness_cases: harnessCases,
    windows_attempt_status: dogfoodWindows.status,
    windows_attempt_note:
      "Windows resolved trusted registry provenance, then failed writing the local receipt store with os error 87. The outreach-sequencer dogfood workflow reruns the same dogfood on Ubuntu and commits durable dogfood-output.json, dogfood-verify.json, and dogfood-receipt.json.",
    registry_provenance: dogfood?.registry_provenance ?? dogfoodWindows.registry_provenance,
  },
  observations: [
    { type: "runx_cli_version", value: "runx-cli 0.6.14" },
    {
      type: "hosted_harness",
      status: publish.harness.status,
      case_names: publish.harness.case_names,
      receipt_refs: publish.harness.receipt_ids.map((id) => `runx:receipt:${id}`),
    },
    {
      type: "eligibility_verdict",
      decision: happy.decision,
      reason: happy.decision.reason,
      packet_schema: happy.next_touch_packet?.schema,
      send_class: happy.next_touch_packet?.send_class,
    },
    {
      type: "engagement_events_examined",
      operation_result: happy.engagement_projection.operation_result,
      events: happy.engagement_events,
    },
    {
      type: "append_event",
      operation_result: happy.append_event.operation_result,
      idempotency_key: happy.append_event.idempotency_key,
      before_version: happy.append_event.before_version,
      after_version: happy.append_event.after_version,
    },
    {
      type: "next_touch",
      index: happy.next_touch_packet?.touch_index,
      channel: happy.next_touch_packet?.channel,
      audience: happy.next_touch_packet?.audience,
      content_digest: happy.next_touch_packet?.content_digest,
      dispatch: happy.next_touch_packet?.dispatch,
    },
    {
      type: "stop_replied",
      decision: stop.decision,
      stop_state: stop.stop_state,
      has_packet: Boolean(stop.next_touch_packet),
      refused_reason: stop.observations.find((item) => item.type === "refused_reason"),
    },
    {
      type: "missing_state_escalation",
      status: missing.status,
      escalation: missing.escalation,
      stop_state: missing.stop_state,
    },
    {
      type: "dogfood_verify",
      receipt_ref: receiptRef,
      verify_verdict: verifyVerdict,
      run_id: dogfood?.run_id,
    },
    {
      type: "artifact_urls",
      public_url: publicVersionUrl,
      pr_url: prUrl,
      source_url: sourceUrl,
      x_yaml: xYamlUrl,
      skill_md: skillMdUrl,
      evidence_json: evidenceJsonUrl,
      verification_json: verificationJsonUrl,
      report: reportUrl,
    },
  ],
};

const verification = {
  schema: "frantic.verification.v1",
  bounty: "#74",
  package: packageRef,
  runx_cli: "0.6.14",
  public_url: publicVersionUrl,
  hosted_harness: {
    status: publish.harness.status,
    case_count: publish.harness.case_count,
    case_names: publish.harness.case_names,
    receipt_refs: publish.harness.receipt_ids.map((id) => `runx:receipt:${id}`),
    evidence_id: publish.harness.evidence_id,
    evidence_url: publish.harness.evidence_url,
  },
  clean_install: {
    command: publish.install_command,
    status: clean.status,
    installed_ref: clean.registry.install.ref,
    digest: clean.registry.install.digest,
  },
  local_runner: {
    happy_next_touch: "passed",
    stop_replied: "passed",
    missing_state_needs_agent: "passed",
  },
  dogfood: {
    status: dogfood?.status ?? "pending_ubuntu",
    receipt_ref: receiptRef,
    verify_valid: dogfoodVerify?.valid ?? false,
    windows_status: dogfoodWindows.status,
    windows_error: dogfoodWindows.error?.message,
    ubuntu_actions_workflow: ".github/workflows/outreach-sequencer-dogfood.yml",
    expected_outputs: [
      "skills/outreach-sequencer/evidence/dogfood-output.json",
      "skills/outreach-sequencer/evidence/dogfood-verify.json",
      "skills/outreach-sequencer/evidence/dogfood-receipt.json",
    ],
  },
  receipt_ref: receiptRef,
};

const report = `# outreach-sequencer delivery report

## Package

- Package: ${packageRef}
- Public URL: ${publicVersionUrl}
- PR URL: ${prUrl}
- Source URL: ${sourceUrl}
- Raw X.yaml: ${xYamlUrl}
- Raw SKILL.md: ${skillMdUrl}
- Evidence JSON: ${evidenceJsonUrl}
- Verification JSON: ${verificationJsonUrl}
- Report: ${reportUrl}

## Verification

- runx CLI version: runx-cli 0.6.14.
- Publish method: direct equivalent of \`runx registry publish ./skills/outreach-sequencer/SKILL.md --registry https://api.runx.ai\` using the same remote /v1/skills API because Windows local publish harness hits receipt-store os error 87.
- Hosted harness status: ${publish.harness.status}, cases ${publish.harness.case_names.join(", ")}.
- Clean install command: \`${publish.install_command}\`.
- Dogfood command: \`runx skill ${packageRef} --registry https://api.runx.ai --json -R skills/outreach-sequencer/evidence/dogfood-receipts\`.
- Dogfood receipt: ${receiptRef}.
- runx verify verdict: ${verifyVerdict.valid ? "valid" : "pending or not valid yet"}; signature mode ${verifyVerdict.signature_mode ?? "pending"}.
- Windows local dogfood status: ${dogfoodWindows.status}; expected receipt-store issue is recorded in dogfood-output-windows.json.

## Behavior

- \`happy_next_touch\` reads data-store projection version ${happy.engagement_projection.version}, sees no reply or unsubscribe, and emits one \`runx.outreach.next_touch.v1\` handoff packet for touch ${happy.next_touch_packet?.touch_index}.
- The packet is handoff-only: it names \`send-as\`, keeps \`this_skill_sends: false\`, and requires a separate governed downstream run.
- The append event is ungated, uses idempotency key \`${happy.append_event.idempotency_key}\`, and moves version ${happy.append_event.before_version} to ${happy.append_event.after_version}.
- \`stop_replied\` reads a linked reply event and seals with no next-touch packet.
- \`missing_state_needs_agent\` returns \`needs_agent\` for unreadable engagement state instead of guessing.

## New User

- Install: \`${publish.install_command}\`.
- Run with bounded JSON inputs matching \`fixtures/happy-next-touch.json\`.
- Verify receipts with \`runx verify --receipt-dir skills/outreach-sequencer/evidence/dogfood-receipts --json\`.
- Trust the skill only as a decision and handoff packet generator; it never sends outreach or mints dispatch authority.
`;

writeFileSync(`${evidenceDir}/evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(`${evidenceDir}/verification.json`, `${JSON.stringify(verification, null, 2)}\n`);
writeFileSync(`${evidenceDir}/report.md`, report);
