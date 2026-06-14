---
name: redact-pii
description: Scrub personal data out of content before it crosses a trust boundary, and refuse to pass content that cannot be scrubbed with confidence.
runx:
  category: security
---

# Redact PII

Decide whether a piece of content is safe to let out, and make it safe when it can be.

Content is about to cross a boundary: a log line headed to a third-party
aggregator, a support transcript pasted into a model prompt, a row exported to a
partner, a draft a teammate will read. Someone, usually an agent, has to answer
one question first. Does this carry personal data, and if it does, can that data
be removed without destroying what the content is for. `redact-pii` answers that
question and returns a pass-or-hold verdict alongside the scrubbed content's
digest.

It is a boundary guard with a pass/hold verdict, not a generic classifier or a
content rewriter. A classifier tells you what is in the text and stops. A
rewriter changes the text to read better. This skill does neither for its own
sake; it detects personal data, removes it under a chosen mode, and refuses to
emit a `ready` verdict when residual risk stays above threshold. The output is a
gate decision, not a tidied draft.

## The decision it makes easier

An agent holding content at a trust boundary cannot eyeball it for a stray email
address, a partial card number, or a name that only becomes identifying next to a
postcode. This skill makes the boundary call explicit and reviewable: it names
every detected class as a span with a confidence, applies the requested
treatment, and returns a verdict the caller can branch on. `ready` means the
scrubbed content may pass. `needs_review` means a human must look before it does.
`blocked` means the content cannot be made safe without losing its meaning, so it
does not pass at all.

## What it refuses to do

- It does not return raw matched values. Detections are spans and class labels;
  the residual is referenced by digest. The thing it is protecting never appears
  in its own output.
- It does not pass content it cannot scrub with confidence. Uncertain detections
  push the verdict to `needs_review`, never silently through.
- It does not rewrite for tone, length, or style. Removing personal data is the
  only edit it makes.
- It does not fetch, send, store, or transmit the content. Scope is read-only on
  the input, no egress; the boundary crossing belongs to the caller.

## Distinctness

Nearest neighbors are `receipt-auditor` and `least-privilege-auditor`. Those read
a sealed receipt after a run to judge authority. `redact-pii` runs before the
fact, on content rather than on a receipt, and emits a forward-looking pass/hold
verdict that gates a crossing rather than scoring a completed one.

## How it works

1. **Set policy.** Resolve the target classes from `classes` and the treatment
   from `mode` (`redact`, `tokenize`, or `block`). With no classes given, default
   to a broad personal-data set: names, emails, phone numbers, postal addresses,
   government and tax identifiers, payment instrument numbers, account and record
   identifiers, precise geolocation, and dates of birth. `locale` tunes the
   identifier and address grammars.
2. **Detect.** Scan the content for each target class. Record every hit as a
   span (offsets, not the matched text) with a class label and a confidence.
3. **Treat.** Apply the mode. `redact` removes the span and leaves a class
   placeholder. `tokenize` replaces it with a stable opaque token so structure
   survives without the value. `block` marks the content as not passable and
   skips emitting a usable residual.
4. **Score residual risk.** Weigh what could still identify a person after
   treatment: low-confidence misses, quasi-identifiers that combine, free-text
   that resists span detection. Set `residual_risk.level` and the reason.
5. **Decide.** Pick the verdict from the residual score. Low risk with confident
   detections clears to `ready`. Uncertainty that could mask a leak holds at
   `needs_review`. Residual risk above threshold, `block` mode, or scrubbing that
   would gut the content's meaning forces `blocked`.
6. **Seal.** Return the report, the digest of the scrubbed content, and the
   policy that governed the pass. The receipt carries the verdict, the detection
   summary (counts and classes, no values), the policy, and the residual digest.

## Governance

- **Scope:** `content:read` only. No `net:*`, no `repo:write`, no store. The
  skill inspects the supplied content and returns a report; it never moves the
  content anywhere.
- **Gate:** the verdict is the gate. `blocked` is a hard refusal to pass.
  `needs_review` is a soft gate that requires a human or a stricter downstream
  skill before the crossing. `ready` is the only verdict that authorizes a pass,
  and it requires residual risk below the configured threshold.
- **Receipt (`runx.redaction.v1`):** carries `decision`, the detection summary
  (class, span, confidence) with no matched values, `redacted_digest`,
  `residual_risk`, and `policy`. The receipt is safe to retain and audit because
  nothing in it reconstructs the personal data it found.

## Safety invariant

Secrets, PII, and raw matched substrings never appear in the report or the
receipt. The `detected` array carries class and span offsets, never the value at
that span. The scrubbed content is represented by `redacted_digest`, never
inlined. If the caller needs the scrubbed content itself, it is returned out of
band by the runner, never folded into the auditable artifact. A report that would
have to quote the personal data to be useful is a report that failed; return
`blocked` instead.

## When to use it

- An agent is about to send content past a trust boundary and must prove it is
  clean first.
- A pipeline step needs a machine-checkable pass/hold gate on personal data
  before export, logging, prompt injection, or sharing.
- A reviewer wants the detection evidence (classes and spans) without ever
  handling the raw values.

## When not to use it

- To classify or label content for analytics. Use a classifier; this skill holds
  a gate.
- To rewrite, summarize, or improve content. Removing personal data is its only
  edit.
- To redact secrets and credentials specifically. Personal data is the target
  here; a credential-bound run belongs with a vault or secret-handling skill that
  returns a bound handle.
- To move the content anywhere. It has no egress by design.

## Quality Profile

- Purpose: decide whether content may cross a trust boundary, scrub the personal
  data when it can, and refuse to pass content that cannot be scrubbed with
  confidence.
- Audience: the agent or pipeline step holding content at a boundary, and the
  reviewer who must trust the pass without ever seeing the raw values.
- Artifact contract: `redaction_report` with `decision` (`ready` |
  `needs_review` | `blocked`), `detected` (array of `{class, span, confidence}`
  carrying no raw values), `redacted_digest`, `residual_risk` (`{level,
  reason}`), and `policy` (`{classes, mode}`).
- Evidence bar: every detection names its class, its span offsets, and a
  confidence. Residual risk states a concrete reason, not a generic disclaimer.
  Uncertainty is reported, never rounded down to clean.
- Voice bar: terse security-reviewer register. CLI and field text stay factual.
  No reassurance, no padding, no claim that content is safe beyond what the
  detections support.
- Strategic bar: the verdict must let a caller branch without re-inspecting the
  content. `ready` carries enough proof to defend the pass in audit; `blocked`
  and `needs_review` name what stopped it.
- Stop conditions: return `needs_review` when detections are uncertain enough to
  risk a leak; return `blocked` when residual risk is above threshold or
  scrubbing would destroy the content's meaning; return `needs_agent` when the
  content input is missing.

## Output

- `redaction_report.decision`: `ready`, `needs_review`, or `blocked`. The gate
  verdict the caller branches on.
- `redaction_report.detected`: array of `{class, span, confidence}`. The class
  label, the span as offsets into the input, and a confidence in `[0,1]`. No
  matched value ever appears here.
- `redaction_report.redacted_digest`: digest of the scrubbed content. The
  scrubbed content itself is never inlined in the report.
- `redaction_report.residual_risk`: `{level, reason}` where `level` is `low`,
  `medium`, or `high` and `reason` names the concrete residual concern.
- `redaction_report.policy`: `{classes, mode}` recording the target classes and
  the treatment that governed this pass.

The runner may also return the scrubbed content out of band for the caller to
forward; it is keyed by `redacted_digest` and is never part of the auditable
report or receipt.

## Inputs

- `content` (required): the content to inspect and scrub.
- `classes` (optional): JSON list of personal-data classes to target. Defaults to
  a broad personal-data set when omitted.
- `mode` (optional): `redact`, `tokenize`, or `block`. Defaults to `redact`.
- `locale` (optional): locale that tunes identifier and address grammars, for
  example `en-US` or `de-DE`.
- `operator_context` (optional): boundary context, threshold posture, or extra
  constraints that focus the pass.
