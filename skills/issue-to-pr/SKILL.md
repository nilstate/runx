---
name: issue-to-pr
description: Implement one bounded repository issue with normal host tools, prove the tested change through one scafld finalize wall, and optionally publish the exact pull request through scoped provider authority with readback.
runx:
  category: code
---

# Issue to PR

Turn one issue into a tested change and, when authorized, a verified pull
request. Use the repository's normal development workflow. Runx owns evidence
continuity and the consequential publication boundary; it does not replace the
host agent's editor, shell, Git, tests, or repository judgment.

## Direct operator flow

1. Resolve the repository from an explicit `owner/name` or the current
   checkout's `origin`. Never infer the target from an available grant.
2. Use the already-authenticated local `gh` and Git paths for inspection.
   Hosted Connect is a compatible fallback or explicit operator binding, not
   the default reason to leave local tooling.
3. Run one preflight before work: issue identity, repository permission, branch
   state, required tools, requested outcome, and publication authority.
4. Investigate, edit, and test with the host agent's ordinary tools. Do not
   manufacture Runx answer files between normal coding steps.
5. Call `scafld finalize` exactly once after the change and tests are ready.
   Preserve its workspace-scoped receipt path, exact target commit, and
   contract digest in `host_result`. Runx verifies that receipt with scafld;
   host-authored status strings are not proof.
6. If PR publication is not authorized, return the tested/finalized result and
   stop. Do not silently downgrade the work to a plan.
7. If publication is authorized, pass the exact `host_result` to `publish`.
   Runx admits one `pullrequest.publish` mutation under the scoped repository
   grant. That boundary publishes
   the exact commit to the requested branch, recovers by reading existing
   remote state, and independently reads the PR back. Notifications, feeds,
   issue comments, and documentation sync are optional downstream skills.

## Reuse in chains

- `from-evidence` accepts `runx.issue_to_pr.issue_evidence.v1` and skips GitHub
  discovery and issue read.
- `resume` accepts both prior issue evidence and a completed
  `runx.issue_to_pr.host_result.v1`; it does not repeat host work or finalize.
- `verify` verifies the signed scafld receipt against the exact commit and
  contract without publishing anything.
- `finalize-local` verifies the completed host result and returns it without a
  remote mutation.
- `publish` verifies the completed host result, publishes its exact Git ref,
  and creates or recovers the authorized PR with readback.
- Preserve the same idempotency key across pause, retry, and resume. An
  uncertain PR creation never gets a new key.

## Host work contract

The `issue-to-pr-host-work` act performs normal repository work and returns:

```yaml
host_result:
  schema: runx.issue_to_pr.host_result.v1
  status: completed | blocked | failed
  repository: owner/name
  issue_number: string
  repo_root: workspace-relative-or-absolute-path
  branch: string
  commit: full-git-object-id
  files: [relative/path]
  tests:
    - command: string
      status: passed | failed
      evidence: string
  finalization:
    receipt_path: workspace-relative-path
    contract_digest: sha256:...
  publication:
    decision: hold | ready
    title: string
    body: string
    head: string
    base: string
    draft: boolean
    idempotency_key: string
  errors: [string]
```

Do not claim `completed` without a real edit/test outcome and one successful
finalize result. Do not claim `published` from a branch push, API
acknowledgement, or draft packet; only independent PR readback closes that
state.

## Stop conditions

- Wrong or ambiguous repository: stop with one target-resolution blocker.
- Missing local auth and no compatible hosted grant: return the exact `gh auth
  login` or `runx connect` handoff; do not cycle through unrelated skills.
- Dirty or conflicting branch state: stop before mutation and preserve the
  evidence already gathered.
- Failed tests or failed/stale finalize: return blocked or failed, never
  succeeded.
- Missing publication authority: retain the tested finalized change locally and
  stop before PR creation.
- Provider failure after admission: preserve the grant reference, idempotency key,
  finalization evidence, and mutation recovery state. Resume at publication;
  do not repeat issue discovery, coding, tests, or finalize.
