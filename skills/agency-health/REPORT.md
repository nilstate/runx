# Agency Health delivery report

- **Source:** `skills/agency-health/X.yaml` and `SKILL.md` define the public skill.
- **State boundary:** the assessment instructions bind each agency decision to a
  domain-keyed `data-store.read_projection` call for `agency_cases`.
- **Cross-run boundary:** `ledger.read` is permitted only for receipt-id stubs;
  raw receipt bodies are not accepted or reproduced.
- **Safety outcome:** no readable events returns `needs_more_evidence`, an
  `unknown` health verdict, and zero findings/interventions.
- **Interventions:** backed policy ambiguity routes to `policy-author`, repeat
  execution failure to `improve-skill`, and cap or authority widening to human
  ops.
- **Fixture evidence:** `concerning-agency-sealed` covers explicit stuck/cap/
  refusal evidence; `no-case-events-stop` covers the deterministic empty-state
  stop.
- **Verification:** local assessor regression, JavaScript syntax check, YAML
  parsing, and `runx skill inspect` passed. The local Windows CLI's temporary
  receipt store is blocked by `os error 5`; the versioned fixtures are retained
  for registry/hosted harness verification.