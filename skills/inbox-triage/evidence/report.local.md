# Inbox Triage Local Evidence Report

## Summary

`inbox-triage` reads a bounded inbox packet, classifies messages, drafts one
safe reply, and stops before sending by emitting a gated send proposal. The
package includes a deterministic `run.mjs` runner, so reviewers can execute the
implementation without relying on an agent-only path.

## Safety Boundary

- No private mailbox access is required.
- Fixtures are synthetic.
- The skill never sends, archives, deletes, unsubscribes, or mutates messages.
- Outbound email is represented only as `gated_send_proposal` with
  `requires_approval: true`.
- `operator_policy.auto_send: true` is refused before drafting.
- Drafting is bounded by supplied sender/operator topics, optional allowed
  intents, and allowed/forbidden commitments.

## Harness Coverage

The Docker/Linux `runx harness` verifies sealed execution and receipt generation
for these declared cases:

- `inbox-triage-happy-path-drafts-gated-reply`
- `inbox-triage-stops-on-missing-sender`
- `inbox-triage-stops-on-missing-body`
- `inbox-triage-refuses-auto-send`
- `inbox-triage-ready-on-digest-only`
- `inbox-triage-stops-when-commitments-not-allowed`

Semantic output checks are recorded separately in `evidence/local-smoke.json`.
Those checks assert the emitted schema, decisions, draft/no-draft behavior,
expected stop fields, happy-path classification labels, and gated send proposal
status.

## Local Verification

- `runx --version`: `runx-cli 0.6.13`
- Node.js in Docker harness: `v20.20.2`
- `runx harness /work/skills/inbox-triage --json --receipt-dir <temp_receipt_dir>`:
  passed
- Harness cases: `6`
- Harness assertion errors: `0`
- Semantic smoke cases: `6`
- Semantic smoke status: `passed`
- `runx doctor skills/inbox-triage --json`: success with zero diagnostics
- Receipt ids:
  `sha256:57f2d9f1f8b79a9c36d89e89a0f7a137c50f40f5d6eff3e46fe0d1de43c687f9`
  `sha256:4b60f3266970630bfdaaaadeaf5a6ad7cfc41d6e543a1742f7f63b35b5130a1a`
  `sha256:b969ea5ab5c05cc18f33bdb16044c020dbd37c1ab7c92f86a7d6283b28a43a57`
  `sha256:335a004673087d83d47273da8aca85c02db4668cc4b7ba606f2046137aa64b4e`
  `sha256:27ee2ee121e0d1c961808da328e4d8818a6423f6e0a4d3f8703556dd3b368e4a`
  `sha256:804bfe223012918274674f9188ca7af0d517acd7b0feb4d50f075c4bd429ec3e`

## Output Evidence

- Emitted packet schema: `runx.inbox.triage.v1`
- Classification labels:
  - `msg-001`: `needs_reply`, `time_sensitive`
  - `msg-002`: `digest`, `no_reply`
  - `msg-digest-001`: `digest`, `no_reply`
- Draft output: the reply acknowledges the sender, defers the final risk update
  until operator review, and avoids final approval.
- Stop conditions:
  - missing sender returns `needs_more_evidence`
  - missing message body returns `needs_more_evidence`
  - auto-send returns `refused`
  - digest-only returns `ready` with no draft
  - disallowed commitments return `needs_more_evidence`
- Gated send proposal: `requires_approval: true`,
  `approval_gate: send-as.explicit-operator-approval`, and
  `status: proposed_not_sent` on the happy path.

The Windows native harness currently fails before skill assertions because the
runx receipt store attempts to sync a directory handle on Windows. The same
failure reproduces on an existing runx skill, while `runx doctor
skills/inbox-triage --json` reports zero diagnostics. The Docker/Linux harness
therefore provides the local pre-submit harness evidence.

## Send-As Composition

The skill composes with send-as by producing a proposal containing recipient,
subject, body reference, and approval gate. A separate send-as runner or human
operator must verify authority and approve the proposal before any outbound
effect.

## Pending Public Submission Fields

The following fields are intentionally still pending because they require
public GitHub, runx registry, or Frantic account actions:

- `public_url`
- `source_url`
- `pr_url`
- raw `x_yaml`
- raw `skill_md`
- hosted `verification_json`
- public dogfood receipt and `runx verify` verdict
