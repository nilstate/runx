---
name: overlay-open-skill-2
description: "Govern a public bug-triage skill under an immutable sha256 pin. Enforces a non-empty scope bound, an explicit allowed-tools set, an allowed_output_prefix attenuation on every emitted path, a max_skills cap on nested skill invocations, and a seal-bearing approval gate when the wrapped guidance proposes security or compliance effects. Read-only and receipt-sealed; never edits the upstream skill."
runx:
  category: governance
---

# overlay-open-skill-2

`overlay-open-skill-2` is a governed wrapper around one distinct open
ecosystem `SKILL.md`. It does not copy the upstream skill; it pins its
content digest, bounds its authority, attenuates its emitted effects, and
seals a receipt for every decision.

## What this skill does

1. Admits only the immutable wrapped bytes identified by `X.yaml.wraps`.
2. Verifies the resolved sha256 digest against the pinned digest. A mismatch
   raises `runx.overlay.digest.stale` and refuses.
3. Bounds the wrapped guidance to one explicit runner scope and one explicit
   allowed-tools set declared in `X.yaml.runners.default.runx`.
4. Attenuates every emitted effect: any output path must satisfy
   `allowed_output_prefix`, and the number of nested skill invocations must
   satisfy `max_skills`. A violation raises `runx.overlay.attenuation.violation`
   and refuses.
5. Routes any wrapped guidance that proposes a security, compliance, or
   outbound-network effect through `requires_approval`, raising
   `runx.overlay.approval.required`, sealing a `pending_approval` receipt, and
   stopping without executing the guidance until an operator approves the
   receipt.
6. Seals a `ready`, `refused`, or `pending_approval` receipt for every
   invocation. The receipt records the resolved digest, the bound check, the
   attenuation check, the approval check, and the final disposition.

## When to use this skill

- Before applying third-party bug-triage guidance to a hosted operator run.
- When an operator wants the upstream guidance content-addressed, scope-bounded,
  output-attenuated, and approval-gated without forking or editing it.
- When a downstream reviewer needs a sealed receipt describing exactly what
  the wrapper admitted and what it refused.

## When not to use this skill

- To modify, commit, push, publish, or otherwise mutate the upstream skill.
- To run wrapped guidance that proposes effects outside `allowed_output_prefix`
  or that exceeds `max_skills` nested calls; the wrapper refuses and seals.
- To trust wrapped guidance that has changed upstream; the pin must be
  re-reviewed against the new digest before the wrapper can admit it.
- To bypass the approval gate on security, compliance, or network effects.

## Governance boundary

| Bound | Value | Source |
| --- | --- | --- |
| `wraps.path` | `https://raw.githubusercontent.com/openai/codex/main/.codex/skills/codex-bug/SKILL.md` | `X.yaml.run.overlay.wraps.path` |
| `pinned_digest` | `sha256:cfdaae2defa524d9f2fb8573bb0e4961c99e2237d48666d9007e0ef5d210cbbf` | `X.yaml.run.overlay.pinned_digest` |
| `runner.scopes` | `["repo.read"]` | `X.yaml.runners.default.runx.scopes` |
| `runner.allowed_tools` | `["shell.exec", "fs.read"]` | `X.yaml.runners.default.runx.allowed_tools` |
| `attenuation.allowed_output_prefix` | `./.runx/bug-triage/` | `X.yaml.run.overlay.attenuation.allowed_output_prefix` |
| `attenuation.max_skills` | `1` | `X.yaml.run.overlay.attenuation.max_skills` |
| `approval.gate_keywords` | `["security", "compliance", "network", "credential", "secret", "publish"]` | `X.yaml.run.overlay.approval.gate_keywords` |

The most restrictive authority wins. A graph or host may narrow this envelope,
but the overlay never widens it. The wrapper refuses any effect whose path
falls outside `allowed_output_prefix`, refuses any nested skill call count
above `max_skills`, and refuses to execute wrapped guidance that names any
`gate_keyword` until an operator approves the pending receipt.

## Procedure

1. Resolve the immutable `wraps.path` declared in `X.yaml`. Compute sha256
   over the exact response bytes without transforming them.
2. Compare the recomputed digest against `pinned_digest`. On mismatch, emit
   `runx.overlay.digest.stale` and seal a `refused` receipt.
3. Bound-check the resolved guidance: confirm `runner.scopes` is non-empty
   and `runner.allowed_tools` is non-empty. An empty set raises
   `runx.overlay.scope.empty` or `runx.overlay.tools.unbounded` and seals a
   `refused` receipt.
4. Attenuation-check every emitted effect:
   - `output_path` must start with `allowed_output_prefix`. A path outside the
     prefix raises `runx.overlay.attenuation.violation` and seals a `refused`
     receipt.
   - `nested_skill_calls` count must be `<= max_skills`. Exceeding the cap
     raises `runx.overlay.attenuation.violation` and seals a `refused` receipt.
5. Approval-check the resolved guidance: if it names any `gate_keyword`,
   raise `runx.overlay.approval.required`, emit a `pending_approval` receipt,
   and stop. The receipt carries an `approval_token`; an operator who supplies
   the matching token via `RUNX_INPUT_APPROVAL_TOKEN` clears the gate and the
   wrapper seals `ready` on the next invocation.
6. When all checks pass, seal a `ready` receipt naming the wrapped content,
   the admitted scope and tool set, the attenuation checks performed, and the
   approval state.

## Run

```sh
runx skill ./skills/overlay-open-skill-2/SKILL.md \
  -i objective='Admit pinned bug-triage guidance before triage review.' \
  -i output_path='./.runx/bug-triage/case-001.md' \
  -i nested_skill_calls=0 \
  --json
```

To clear a pending approval gate on a subsequent invocation, supply the
token returned in the `pending_approval` receipt:

```sh
runx skill ./skills/overlay-open-skill-2/SKILL.md \
  -i objective='Admit pinned bug-triage guidance with operator approval.' \
  -i output_path='./.runx/bug-triage/case-002.md' \
  -i nested_skill_calls=0 \
  -i approval_token='<token-from-pending-receipt>' \
  --json
```

The optional `objective` is receipt context only; it grants no additional
authority. When `output_path` is omitted, the wrapper seals a deterministic
`needs_input` receipt and does not claim that the wrapped content is admissible.

## Refusal and approval paths

- **Stale digest** → `decision: refused`, `runx.overlay.digest.stale`, exit
  non-zero, sealed failed receipt. Changed instructions are never executed
  unseen.
- **Empty bound or tool set** → `decision: refused`, `runx.overlay.scope.empty`
  or `runx.overlay.tools.unbounded`, sealed failed receipt.
- **Path outside `allowed_output_prefix`** → `decision: refused`,
  `runx.overlay.attenuation.violation`, sealed failed receipt.
- **Nested skill count over `max_skills`** → `decision: refused`,
  `runx.overlay.attenuation.violation`, sealed failed receipt.
- **Wrapped guidance names a gate keyword** → `decision: pending_approval`,
  `runx.overlay.approval.required`, sealed `pending_approval` receipt with
  `approval_token`. The wrapper stops without executing the guidance.
- **Invalid `approval_token`** → `decision: refused`,
  `runx.overlay.approval.rejected`, sealed failed receipt.

## Output schema

```json
{
  "schema": "runx.skill_overlay.v2",
  "objective": "string",
  "wraps": {
    "path": "immutable HTTPS URL",
    "digest": "sha256:<64 lowercase hex>"
  },
  "resolved_digest": "sha256:<64 lowercase hex> | null",
  "runner": {
    "type": "agent",
    "scopes": ["repo.read"],
    "allowed_tools": ["shell.exec", "fs.read"]
  },
  "attenuation": {
    "allowed_output_prefix": "./.runx/bug-triage/",
    "max_skills": 1,
    "output_path_check": "passed | refused",
    "nested_skill_calls_check": "passed | refused"
  },
  "approval": {
    "state": "none | pending | approved | rejected",
    "gate_keywords": ["security", "compliance", "network", "credential", "secret", "publish"],
    "approval_token": "string | null"
  },
  "decision": "ready | needs_input | refused | pending_approval",
  "diagnostics": [
    { "id": "string", "severity": "error | warning", "message": "string" }
  ],
  "receipt_local": {
    "schema": "runx.receipt.local.v1",
    "algorithm": "sha256",
    "digest": "<64 lowercase hex>"
  }
}
```

## Verification contract

The inline harness contains four cases:

1. `pinned-digest-seals` proves the exact pinned digest admits a read-only
   guidance invocation under the declared attenuation and seal a `ready`
   receipt.
2. `digest-stale-refuses` proves changed wrapped bytes raise
   `runx.overlay.digest.stale` and seal a `refused` receipt.
3. `attenuation-violation-refuses` proves an emitted path outside
   `allowed_output_prefix` raises `runx.overlay.attenuation.violation` and
   seals a `refused` receipt.
4. `approval-required-pending` proves wrapped guidance that names a
   `gate_keyword` raises `runx.overlay.approval.required` and seals a
   `pending_approval` receipt without executing the guidance.

Standalone fixtures mirror the inline cases under `fixtures/` for direct
replay and public review.

## Inputs

- `objective` (optional string): receipt context; grants no authority.
- `output_path` (optional string): the absolute or relative path the wrapped
  guidance intends to write. When omitted, the wrapper seals `needs_input`.
  Must satisfy `allowed_output_prefix` when supplied.
- `nested_skill_calls` (optional non-negative integer): the number of nested
  skill invocations the wrapped guidance intends to issue. Defaults to `0`.
  Must be `<= max_skills`.
- `approval_token` (optional string): the token emitted by an earlier
  `pending_approval` receipt. When supplied, the wrapper clears the gate
  for this invocation.