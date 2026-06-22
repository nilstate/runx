# Standup Digest verification report

## Result

The skill passes `runx doctor` with zero errors and warnings and passes both
required local harness cases with `runx-cli 0.6.13`. The two generated receipts
are sealed and signature-verifiable.

## Behavior covered

The sealed case classifies merged work, a failed blocker, an explicit risk, and
an open next action. The noisy case collapses a duplicate notification while
retaining both event IDs, ignores an untraceable event without an ID, and keeps
the remaining action traceable.

Outputs are typed as arrays or objects in `X.yaml`. Every digest item carries
source event IDs, source timestamps, and source links. `digest_meta` records
event counts, duplicate groups, ignored events, blocker criteria, and the
absence of side effects.

## Composition

`github-sync` can collect bounded GitHub events before this skill.
`issue-triage` can classify raw issues before digest generation.
`slack-notify` can deliver the resulting packet afterward. Keeping those stages
separate gives collection, triage, summarization, and delivery their own policy
and receipt boundaries.

