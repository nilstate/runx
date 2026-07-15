---
name: redact-pii
description: Scrub personal data out of content before it crosses a trust boundary, and refuse to pass content that cannot be scrubbed with confidence.
runx:
  category: security
---

# Redact PII

Decide whether a piece of content is safe to let out, and make it safe when it can be.

## What this skill does

`redact-pii` is a boundary guard with a pass/hold verdict. Content is about to
cross a boundary: a log line headed to a third-party aggregator, a support
transcript pasted into a model prompt, a row exported to a partner, a draft a
teammate will read. The skill answers one question before the crossing. Does
this carry personal data, and if it does, can that data be removed without
destroying what the content is for.

It detects personal data, removes it under a chosen mode, and returns a verdict
the caller can branch on alongside the scrubbed content's digest. The verdict is
the gate: `ready` authorizes a pass, `needs_review` holds for a human, `blocked`
refuses the crossing. The output is a gate decision, not a tidied draft.

## When to use this skill

- An agent is about to send content past a trust boundary and must prove it is
  clean first.
- A pipeline step needs a machine-checkable pass/hold gate on personal data
  before export, logging, prompt injection, or sharing.
- A reviewer wants the detection evidence, classes and spans, without ever
  handling the raw values.

## When not to use this skill

- To classify or label content for analytics. Use a classifier; this skill
  holds a gate. A classifier tells you what is in the text and stops; this skill
  emits a forward-looking pass/hold verdict that gates the crossing.
- To rewrite, summarize, or improve content. Removing personal data is its only
  edit.
- To redact secrets and credentials specifically. Personal data is the target
  here; a credential-bound run belongs with a vault or secret-handling skill
  that returns a bound handle.
- To move the content anywhere. It has no egress by design; the boundary
  crossing belongs to the caller.

Nearest neighbors are `audit-receipt` and `least-privilege`. Those
read a sealed receipt after a run to judge authority. `redact-pii` runs before
the fact, on content rather than on a receipt.

## Procedure

1. **Set policy.** Resolve the target classes from `classes` and the treatment
   from `mode` (`redact`, `tokenize`, or `block`). With no classes given,
   default to a broad personal-data set: names, emails, phone numbers, postal
   addresses, government and tax identifiers, payment instrument numbers,
   account and record identifiers, precise geolocation, and dates of birth.
   `locale` tunes the identifier and address grammars.
2. **Detect.** Scan the content for each target class. Record every hit as a
   span (offsets, not the matched text) with a class label and a confidence.
3. **Treat.** Apply the mode. `redact` removes the span and leaves a class
   placeholder. `tokenize` replaces it with a stable opaque token so structure
   survives without the value. `block` marks the content as not passable and
   skips emitting a usable residual.
4. **Score residual risk.** Weigh what could still identify a person after
   treatment: low-confidence misses, quasi-identifiers that combine, free text
   that resists span detection. Set `residual_risk.level` and the reason.
5. **Decide the gate.** Pick the verdict from the residual score. Low risk with
   confident detections clears to `ready`. Uncertainty that could mask a leak
   holds at `needs_review`. Residual risk above threshold, `block` mode, or
   scrubbing that would gut the content's meaning forces `blocked`.
6. **Seal.** Return the report, the digest of the scrubbed content, and the
   policy that governed the pass. The receipt carries the verdict, the detection
   summary (counts and classes, no values), the policy, and the residual digest.
   The receipt is safe to retain and audit because nothing in it reconstructs
   the personal data it found.

## Edge cases and stop conditions

- **No content input:** return `needs_agent`; there is nothing to inspect.
- **Uncertain detections:** return `needs_review`. Detections uncertain enough
  to mask a leak push the verdict to hold, never silently through.
- **Residual risk above threshold:** return `blocked`. `ready` is the only
  verdict that authorizes a pass, and it requires residual risk below the
  configured threshold.
- **Scrubbing destroys meaning:** return `blocked` when quasi-identifiers are
  interleaved with the content's substance and removing them strips the meaning.
- **`block` mode:** the content is marked not passable and no usable residual is
  emitted.
- **Raw value would be needed to be useful:** a report that would have to quote
  the personal data is a report that failed; return `blocked` instead.

Scope is `content:read` only. No `net:*`, no `repo:write`, no store. The skill
inspects the supplied content and returns a report; it never moves the content
anywhere. The gate authority lives in the verdict: `blocked` is a hard refusal
to pass, `needs_review` requires a human or a stricter downstream skill before
the crossing, and `ready` is the only grant that lets the scrubbed content out.

Secrets, PII, and raw matched substrings never appear in the report or the
receipt. The `detected` array carries class and span offsets, never the value at
that span. The scrubbed content is referenced by `redacted_digest`, never
inlined. If the caller needs the scrubbed content itself, the runner returns it
out of band, keyed by `redacted_digest`, never folded into the auditable proof.

## Output schema

```yaml
redaction_report:
  decision: ready | needs_review | blocked
  detected:
    - class: string          # personal-data class label, no raw value
      span: [int, int]       # offsets into the input, not the matched text
      confidence: number     # confidence in [0,1]
  redacted_digest: string    # digest of the scrubbed content, never inlined; null under block
  residual_risk:
    level: low | medium | high
    reason: string           # the concrete residual concern, not a generic disclaimer
  policy:
    classes: array           # target classes that governed this pass
    mode: redact | tokenize | block
```

The runner may also return the scrubbed content out of band for the caller to
forward; it is keyed by `redacted_digest` and is never part of the auditable
report or receipt (`runx.redaction.v1`).

## Worked example

Input: the line "Customer Dana Whitfield wrote in from dana.w@example.com about
order #44120; callback number on file is 415-555-0188." with `classes: [name,
email, phone]`, `mode: redact`, `locale: en-US`.

Output: `decision: ready`. Three personal spans are detected and removed at high
confidence: the name, the email, and the phone number, each named by class and
offset with no value emitted. The order id is a record reference, not a personal
identifier, so it stays. `residual_risk.level: low`, and the scrubbed content is
referenced only by `redacted_digest`. The verdict grants the pass; the receipt
seals with the detection summary and policy.

## Inputs

- `content` (required): the content to inspect and scrub.
- `classes` (optional): JSON list of personal-data classes to target. Defaults
  to a broad personal-data set when omitted.
- `mode` (optional): `redact`, `tokenize`, or `block`. Defaults to `redact`.
- `locale` (optional): locale that tunes identifier and address grammars, for
  example `en-US` or `de-DE`.
- `operator_context` (optional): boundary context, threshold posture, or extra
  constraints that focus the pass.
