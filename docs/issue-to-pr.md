# Issue To PR Flow

`issue-to-pr` is the generic runx lane for turning one bounded source thread
into one governed draft pull request. It is not a Slack bot, Sentry handler, or
repo-specific triage policy.

The lane exists to make the engineering story reviewable:

1. Intake source: the original issue, chat thread, alert, or local work item.
2. Triage decision: why a PR is justified, or why the lane should stop.
3. scafld spec: the code-change contract and declared validation.
4. Build evidence: what changed and which checks ran.
5. Review result: adversarial findings and remaining risk.
6. Draft PR: linked, refreshed, and ready for a human reviewer.
7. Human merge gate: the generated PR is never auto-merged by this lane.
8. Final outcome: merged, closed, or superseded state posted back to the source
   thread when the provider can be observed.

## Ownership Boundary

runx owns reusable machinery:

- normalized source threads
- lifecycle story helpers
- outbox entries and publication metadata
- receipt evidence
- scafld command boundaries
- provider adapters such as GitHub issue comments and pull requests
- idempotent update behavior for retries

Consuming repos own product policy:

- which Slack channels, Sentry alerts, GitHub issues, or support tools can start
  a lane
- how source messages are filtered to avoid non-issues
- which repo receives the work
- who is assigned for human review
- whether GitHub Projects, labels, or milestones are used
- deployment and live bot credentials

That split keeps `issue-to-pr` reusable. A service repo can normalize Slack or
Sentry into a `runx.thread.v1` source, but runx core should not know that
Nitrosend uses a particular channel, label, or owner map.

## Reviewer Context

The source issue and PR should be comprehensive without becoming an event log.
Use durable gate summaries, not every internal transition. The canonical lane
publishes the draft PR, then updates the source thread with a merge-gate story
and, when observed later, a stable outcome story so reviewers do not have to
reconstruct state from receipts.

Good public story sections include:

- source summary and relevant evidence
- triage decision and why build is justified
- scoped files or surfaces
- validation commands and results
- review verdict and actionable findings
- PR link and human merge instruction
- final merged or closed outcome

Do not publish:

- raw local absolute paths
- secret values or provider tokens
- full command dumps when a concise result is enough
- duplicate status comments for retry attempts
- provider-specific policy that belongs in the consuming repo

## Naming

The graph may still use low-level runner contracts internally. Human-facing
docs, labels, and comments should describe those boundaries as agent-mediated
authoring, review, or decision steps. Public runner and schema identifiers must
cut over cleanly with every call site updated in the same change.

## Security Shape

The lane fails closed when source context, scafld state, provider auth, branch,
or review evidence is missing. The generated PR remains draft/reviewable, and a
human controls the merge. Post-merge behavior is observation and source-thread
update, not automatic merge.

Retries must reuse the same outbox entry, issue comment, branch, and PR when
possible. Duplicates are a correctness bug because the source thread is the
control surface.

## Live Operations Preflight

Use the live preflight before running against a real GitHub issue:

```bash
pnpm live:issue-to-pr -- --repo owner/repo --issue 123 --workspace /path/to/repo
```

The preflight is read-only. It verifies that the workspace is a scafld repo,
that the workspace is on the intended issue branch, that the selected scafld
binary can run in that workspace, and that `RUNX_BIN` is either unset or points
at an executable CLI. It returns JSON with blocked checks and the exact dogfood
command to run next.

If the workspace is clean and you want the live command to create or switch to
the issue branch before mutation, pass `--prepare-branch`:

```bash
pnpm live:issue-to-pr -- --prepare-branch --repo owner/repo --issue 123 --workspace /path/to/repo
```

When the preflight is ready, run:

```bash
pnpm dogfood:github-issue-to-pr -- --prepare-branch --repo owner/repo --issue 123 --workspace /path/to/repo
```

The dogfood command hydrates the GitHub issue thread, executes the governed
lane, publishes the draft PR through `thread.push_outbox`, and rehydrates the
source thread so the output shows before/after provider state.

## Fixtures

Use the checked-in thread fixtures when building repo-local wrappers:

- `fixtures/threads/issue-to-pr-file-thread.json` shows a local file-backed
  work item for deterministic tests.
- `fixtures/threads/issue-to-pr-github-thread.json` shows the normalized shape
  a GitHub issue adapter should produce.
- `fixtures/issue-to-pr/dogfood-answers.json` is an empty caller-answer file
  for dogfood commands that should fail closed before real provider context is
  supplied.

## Aster Live Handoff

Aster should consume this as a runx proving-ground lane, not as OSS policy.

Mapping:

- Aster `issue-triage` decides whether a public issue deserves reply, plan, or
  build.
- Aster `fix-pr` and `docs-pr` prepare repo-local policy: target repo, branch,
  authoring model, labels, and publication gate.
- The normalized source issue becomes the `thread` input for `issue-to-pr`.
- `issue-to-pr` owns scafld lifecycle, draft PR packaging, receipts, and generic
  GitHub thread updates.
- Aster keeps the rolling work-issue status comment and generated-PR policy.

The live merge gate remains human. Aster may observe the merged PR and publish
the final source-thread outcome, but it should not merge generated changes.
