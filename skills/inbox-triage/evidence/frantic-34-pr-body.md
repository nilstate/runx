## Summary

Adds `inbox-triage`, a runx skill that reads a bounded inbox packet, classifies
messages, prepares a triage queue, drafts a safe reply, and stops before any
send by emitting a `gated_send_proposal`.

The implementation includes a deterministic local `run.mjs` runner, so the
skill can be exercised directly by the native harness instead of relying only on
agent instructions. Drafting is bounded by supplied sender/operator topics,
optional allowed intents, and allowed/forbidden commitments. Digest-only packets
finish as no-reply work without producing a send proposal.

## Bounty

Prepared for Frantic bounty #34:

https://gofrantic.com/bounties/34

## Safety boundary

- Uses synthetic fixture packets only.
- Does not connect to a private mailbox.
- Does not send, archive, delete, unsubscribe, or mutate messages.
- Any outbound email is represented as a send-as approval proposal with
  `requires_approval: true`.
- Explicit auto-send requests are refused before drafting.

## Harness coverage

Local Docker/Linux harness evidence was generated with `runx-cli 0.6.13` and Node `v20.20.2`.

```text
runx harness /work/skills/inbox-triage --json --receipt-dir <temp_receipt_dir>
```

Result:

```json
{
  "status": "passed",
  "case_count": 6,
  "assertion_error_count": 0,
  "case_names": [
    "inbox-triage-happy-path-drafts-gated-reply",
    "inbox-triage-stops-on-missing-sender",
    "inbox-triage-stops-on-missing-body",
    "inbox-triage-refuses-auto-send",
    "inbox-triage-ready-on-digest-only",
    "inbox-triage-stops-when-commitments-not-allowed"
  ]
}
```

`evidence/local-smoke.json` records direct semantic assertions for runner output:
schema, decisions, draft/no-draft behavior, stop fields, classification labels,
and gated send proposal status.

The repository-local Windows native harness currently fails before skill
assertions because the runx receipt store attempts to sync a directory handle on
Windows. The same failure reproduces on an existing runx skill. `runx doctor
skills/inbox-triage --json` reports zero diagnostics, and the Docker/Linux run
provides green local harness evidence.

## Files

- `skills/inbox-triage/SKILL.md`
- `skills/inbox-triage/X.yaml`
- `skills/inbox-triage/run.mjs`
- `skills/inbox-triage/fixtures/happy-path.json`
- `skills/inbox-triage/fixtures/missing-sender.json`
- `skills/inbox-triage/fixtures/missing-body.json`
- `skills/inbox-triage/fixtures/auto-send-refused.json`
- `skills/inbox-triage/fixtures/digest-only.json`
- `skills/inbox-triage/fixtures/commitment-disallowed.json`
- `skills/inbox-triage/evidence/local-harness.docker.json`
- `skills/inbox-triage/evidence/local-doctor.docker.json`
- `skills/inbox-triage/evidence/local-receipts.docker.json`
- `skills/inbox-triage/evidence/local-smoke.json`
- `skills/inbox-triage/evidence/local-evidence.docker.json`
- `skills/inbox-triage/evidence/report.local.md`
- `skills/inbox-triage/evidence/runx-version.txt`
