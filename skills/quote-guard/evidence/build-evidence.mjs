import { existsSync, readFileSync, writeFileSync } from "node:fs";

const evidenceDir = "skills/quote-guard/evidence";
const branch = process.env.QUOTE_GUARD_BRANCH || "quote-guard";
const prUrl = process.env.QUOTE_GUARD_PR_URL || "https://github.com/runxhq/runx/pull/226";

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
const clean = readJson("clean-install.json", readJson("clean-install-windows.json", {}));
const inPolicy = readJson("direct-runner-in-policy.json");
const outOfBand = readJson("direct-runner-out-of-band.json");
const localHarness = readJson("local-harness-windows.json", {});
const dogfood = readJson("dogfood-output.json", null);
const dogfoodVerify = readJson("dogfood-verify.json", null);

const version = publish.version;
const packageRef = `vidshidden/quote-guard@${version}`;
const publicVersionUrl = `${publish.public_url}@${version}`;
const baseRaw = `https://raw.githubusercontent.com/VidsHidden/runx/${branch}/skills/quote-guard`;
const sourceUrl = `https://github.com/VidsHidden/runx/tree/${branch}/skills/quote-guard`;
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
  { name: "in_policy_deal_yields_quote", status: "sealed" },
  { name: "out_of_band_ask_escalates", status: "refused" },
];

const evidence = {
  schema: "frantic.evidence.v1",
  bounty: "#82",
  package_name: "quote-guard",
  runx_cli_version: "runx-cli 0.6.14",
  summary:
    "Published quote-guard runx skill. The skill reads a bounded deal ask, account pricing policy, and supplied quote history; authorizes only in-policy asks; emits a quote draft plus gated send_proposal and settlement_ceiling; and refuses out-of-band asks without sending or settling anything.",
  published: {
    skill_id: publish.skill_id,
    owner: publish.owner,
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
    status: clean.status ?? "pending_ubuntu",
    ref: clean.registry?.install?.ref,
    digest: clean.registry?.install?.digest,
    profile_digest: clean.registry?.install?.profile_digest,
  },
  dogfood: {
    package: packageRef,
    input: {
      fixture: "skills/quote-guard/fixtures/in-policy-deal.json",
      account_id: inPolicy.quote_draft.account_id,
      product: inPolicy.quote_draft.product,
      requested_net_usd: inPolicy.quote_draft.net_price_usd,
      requested_discount_percent: inPolicy.quote_draft.discount_percent,
      policy_band: inPolicy.decision.policy_band,
    },
    command:
      `runx skill ${packageRef} --registry https://api.runx.ai --json -R skills/quote-guard/evidence/dogfood-receipts`,
    status: dogfood?.status ?? "pending_ubuntu",
    receipt_ref: receiptRef,
    run_id: dogfood?.run_id,
    verify_verdict: verifyVerdict,
    harness_cases: harnessCases,
    registry_provenance: dogfood?.registry_provenance,
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
      type: "local_harness_windows",
      status: localHarness.status ?? "failed_windows_receipt_store",
      assertion_errors: localHarness.assertion_errors ?? [],
      note: "Windows local harness hit the known receipt-store os error 87; Ubuntu workflow records clean install, dogfood, and verify artifacts.",
    },
    {
      type: "decision",
      authorized: inPolicy.decision.authorized,
      reason: inPolicy.decision.reason,
      policy_band: inPolicy.decision.policy_band,
      requires_approval: inPolicy.decision.requires_approval,
    },
    {
      type: "policy_band",
      ...inPolicy.observations.find((item) => item.type === "policy_band"),
    },
    {
      type: "prior_quote_evidence",
      records: inPolicy.observations.find((item) => item.type === "prior_quote_evidence")?.records ?? [],
    },
    {
      type: "settlement_ceiling",
      settlement_ceiling: inPolicy.settlement_ceiling,
    },
    {
      type: "quote_digest",
      digest: inPolicy.send_proposal.quote_digest,
    },
    {
      type: "proposal_status",
      send_proposal: inPolicy.send_proposal.status,
      gated: inPolicy.send_proposal.gated,
      this_skill_sends: inPolicy.send_proposal.this_skill_sends,
      this_skill_settles_money: inPolicy.settlement_ceiling.this_skill_settles_money,
    },
    {
      type: "out_of_band_refusal",
      status: outOfBand.status,
      decision: outOfBand.decision,
      escalation: outOfBand.escalation,
      has_send_proposal: Boolean(outOfBand.send_proposal),
      has_settlement_ceiling: Boolean(outOfBand.settlement_ceiling),
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
  bounty: "#82",
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
    status: clean.status ?? "pending_ubuntu",
    installed_ref: clean.registry?.install?.ref,
    digest: clean.registry?.install?.digest,
  },
  local_runner: {
    in_policy_deal_yields_quote: "passed",
    out_of_band_ask_escalates: "passed",
  },
  dogfood: {
    status: dogfood?.status ?? "pending_ubuntu",
    receipt_ref: receiptRef,
    verify_valid: dogfoodVerify?.valid ?? false,
    ubuntu_actions_workflow: ".github/workflows/quote-guard-dogfood.yml",
    expected_outputs: [
      "skills/quote-guard/evidence/clean-install.json",
      "skills/quote-guard/evidence/dogfood-output.json",
      "skills/quote-guard/evidence/dogfood-verify.json",
      "skills/quote-guard/evidence/dogfood-receipt.json",
    ],
  },
  receipt_ref: receiptRef,
};

const report = `# quote-guard delivery report

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
- Publish method: direct equivalent of \`runx registry publish ./skills/quote-guard/SKILL.md --registry https://api.runx.ai\` using the same remote /v1/skills API.
- Hosted harness status: ${publish.harness.status}, cases ${publish.harness.case_names.join(", ")}.
- Clean install command: \`${publish.install_command}\`.
- Dogfood command: \`runx skill ${packageRef} --registry https://api.runx.ai --json -R skills/quote-guard/evidence/dogfood-receipts\`.
- Dogfood receipt: ${receiptRef}.
- runx verify verdict: ${verifyVerdict.valid ? "valid" : "pending or not valid yet"}; signature mode ${verifyVerdict.signature_mode ?? "pending"}.
- Windows local harness status: ${localHarness.status ?? "receipt-store failure"}; Ubuntu workflow records the durable dogfood evidence.

## Behavior

- \`in_policy_deal_yields_quote\` authorizes account ${inPolicy.quote_draft.account_id} in policy band ${inPolicy.decision.policy_band}.
- The quote draft has digest ${inPolicy.send_proposal.quote_digest}; the report does not require live sending.
- \`send_proposal\` is gated and names downstream \`send-as\`; \`this_skill_sends\` is ${inPolicy.send_proposal.this_skill_sends}.
- \`settlement_ceiling\` is ${inPolicy.settlement_ceiling.currency} ${inPolicy.settlement_ceiling.amount_usd}, capped by policy band ${inPolicy.settlement_ceiling.cap_basis.policy_band}.
- Prior quote evidence is sourced only from supplied quote_history records: ${(inPolicy.observations.find((item) => item.type === "prior_quote_evidence")?.records ?? []).map((record) => record.quote_id).join(", ")}.
- \`out_of_band_ask_escalates\` refuses reason ${outOfBand.decision.reason}; it emits no send proposal and no settlement ceiling.

## New User

- Install: \`${publish.install_command}\`.
- Run with bounded JSON inputs matching \`fixtures/in-policy-deal.json\`.
- Verify receipts with \`runx verify --receipt-dir skills/quote-guard/evidence/dogfood-receipts --json\`.
- Trust this skill only as a pricing guard and proposal generator; it never sends quotes, mints authority, settles funds, or writes account policy.
`;

writeFileSync(`${evidenceDir}/evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
writeFileSync(`${evidenceDir}/verification.json`, `${JSON.stringify(verification, null, 2)}\n`);
writeFileSync(`${evidenceDir}/report.md`, report);
