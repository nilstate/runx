# Docs Doctor — Harness Evidence

Local harness: `node ./skills/docs-doctor/run.mjs` (no external services).

## Cases

1. **`docs-doctor-flags-stale-coverage-with-proposal`**: corpus is missing docs for `runx add`, `runx verify`, and the registry endpoints/schemas. The runner emits `doc_findings`, `coverage_map`, `patch_plan`, and a `docs_pr_proposal` with `proposed=true`.
2. **`docs-doctor-healthy-corpus-no-proposal`**: corpus already covers the product surface (commands, deprecated markers aligned with `stable=false`, no endpoints/schemas). The runner emits `coverage_map` with `missing=0, partial=0` and a `docs_pr_proposal` with `proposed=false`.
3. **`docs-doctor-needs-required-inputs`**: empty inputs. The runner refuses with exit 64 and `docs_corpus must be an array`.

## Local verification

```bash
cd skills/docs-doctor
for case in 1 2 3; do
  echo "--- case $case ---"
  case $case in
    1) RUNX_INPUTS_JSON='{"docs_corpus":[{"page":"commands/runx-install","path":"docs/commands/runx-install.md","body":"# runx install"},{"page":"commands/runx-publish","path":"docs/commands/runx-publish.md","body":"# runx publish"}],"product_surface":{"commands":[{"name":"runx install","stable":true},{"name":"runx add","stable":true,"note":"canonical"},{"name":"runx publish","stable":true},{"name":"runx verify","stable":true}],"endpoints":[{"name":"registry publish","method":"POST","path":"/v1/registry/packages"},{"name":"registry read","method":"GET","path":"/v1/registry/packages/{name}@{version}"}],"schemas":[{"name":"runx.receipt.v1","path":"schemas/receipt.json"}]},"user_task_matrix":[{"task":"install a published skill","expected_help":["commands/runx-install","commands/runx-add"]},{"task":"publish a new skill version","expected_help":["commands/runx-publish"]},{"task":"verify a published skill","expected_help":["commands/runx-verify"]}],"style_policy":{"tone":"operator","voice":"concise","max_paragraph_chars":280,"required_evidence_in_finding":true}}' node run.mjs ;;
    2) RUNX_INPUTS_JSON='{"docs_corpus":[{"page":"commands/runx-install","path":"docs/commands/runx-install.md","body":"# runx install (deprecated)\nUse `runx add` instead."},{"page":"commands/runx-add","path":"docs/commands/runx-add.md","body":"# runx add\nInstall."},{"page":"commands/runx-publish","path":"docs/commands/runx-publish.md","body":"# runx publish\nPublish."},{"page":"commands/runx-verify","path":"docs/commands/runx-verify.md","body":"# runx verify\nVerify."}],"product_surface":{"commands":[{"name":"runx install","stable":false},{"name":"runx add","stable":true},{"name":"runx publish","stable":true},{"name":"runx verify","stable":true}],"endpoints":[],"schemas":[]},"user_task_matrix":[{"task":"install a published skill","expected_help":["commands/runx-install","commands/runx-add"]},{"task":"publish a new skill version","expected_help":["commands/runx-publish"]},{"task":"verify a published skill","expected_help":["commands/runx-verify"]}],"style_policy":{"tone":"operator","voice":"concise","max_paragraph_chars":280,"required_evidence_in_finding":true}}' node run.mjs ;;
    3) RUNX_INPUTS_JSON='{}' node run.mjs ;;
  esac
done
```

## Inputs (typed)

- `docs_corpus[]` — `{page, path, body}` per shipped doc page
- `product_surface` — `{commands[], endpoints[], schemas[]}` describing the real surface
- `user_task_matrix[]` — `{task, expected_help[]}` describing user tasks
- `style_policy` — `{tone, voice, max_paragraph_chars, required_evidence_in_finding}`

## Outputs (typed)

- `doc_findings[]` — each: `page, issue, severity, doc_evidence, product_surface_evidence, proposed_fix_scope`
- `coverage_map` — `{commands[], endpoints[], schemas[], tasks[], covered, missing, partial}`
- `patch_plan[]` — ordered edit units: `{target_page, change, evidence_refs}`
- `docs_pr_proposal` — gated proposal: `{proposed, channel, gated, blocker_count, warning_count, patch_plan_size, reason}`

## Rules (in run.mjs)

- Cite product-surface evidence for every stale/missing/partial claim.
- Refuse to invent coverage.
- Group findings by severity ∈ {blocker, warning, nit}.
- Never edit a repo; emit a gated proposal only.
- Do not echo secrets/customer data/private IDs into findings.