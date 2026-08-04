---
name: redact-pii
description: Detect and remove personal data before content crosses a trust boundary, returning usable scrubbed content only when a deterministic residual scan passes. Use for exports, prompts, logs, support material, or outbound handoffs that need a pass, review, or block verdict; it does not move content or handle credentials.
---

# Redact PII

Treat the verdict as a boundary gate. Only `ready` returns content that may cross the boundary. `needs_review` and `blocked` return no residual content.

## Procedure

1. Resolve `mode`: `redact`, `tokenize`, or `block`. Resolve target classes from `classes`; omitted classes use the broad default policy.
2. Inspect the supplied content and return PII detections as class, UTF-16 code-unit span, and confidence. Never copy a matched value into the report or reasoning.
3. Use semantic judgment for names, addresses, quasi-identifiers, and whether removal destroys meaning. Choose `needs_review` when confidence is insufficient.
4. The deterministic finalizer validates spans and policy, performs the replacements itself, scans the residual for direct and obfuscated high-confidence identifiers, computes source and residual digests, and strips residual content unless the final decision is `ready`.
5. A `block` policy always returns `blocked`. This skill never sends, exports, logs, or stores content.

The finalizer, not the agent, owns replacement text and digests. `redact` emits `[REDACTED:CLASS]`; `tokenize` emits stable per-document `[TOKEN:CLASS:N]` placeholders. Invalid or overlapping spans fail closed.

## Output

```yaml
redaction_report:
  decision: ready | needs_review | blocked
  detected:
    - class: string
      span: [integer, integer]
      confidence: number
  source_digest: sha256:...
  redacted_digest: sha256:... | null
  residual_risk:
    level: low | medium | high
    reason_code: string
    reason: string
  scanner:
    status: pass | hold | block
    findings:
      - class: string
        span: [integer, integer]
        rule: string
  policy:
    classes: array
    mode: redact | tokenize | block
    locale: string
redacted_content: string
```

Scanner findings contain locations and rule names, never matched values. A clean scanner does not prove that semantic identifiers cannot exist; that uncertainty remains the reviewer agent's job and must produce `needs_review` when material.

## Agent task contracts

### `redact-pii-detect`

Inspect only the supplied content. Return redaction_draft with decision (ready, needs_review, or
blocked), detected spans as class, UTF-16 start/end offsets, and confidence, plus residual_risk
with level and reason_code. Never include matched values. Use reason_code none,
ambiguous_semantics, scrubbing_destroys_meaning, policy_block, or insufficient_context. The
deterministic finalizer owns all replacements, scanning, digests, and the final pass gate.
