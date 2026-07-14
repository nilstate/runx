---
name: overlay-open-skill-1
description: Govern an operational browser-testing skill from the open skill ecosystem under an immutable sha256 pin, one exact allowed origin, a bounded browser-action budget, an explicit tool set, and a native approval gate before any session is admitted.
runx:
  category: governance
---

# Governed browser-testing overlay

Use a practical browser-testing skill from the open skill ecosystem without
silently trusting future edits or granting an unbounded browser session.

This package never copies or edits the wrapped instructions. `X.yaml` points to
one immutable public file and pins its exact response bytes by sha256. Every run
validates that pin, consumes caller-supplied origin and action limits, records a
native approval decision, and seals a final governance packet. A downstream host
may invoke the wrapped instructions only after the packet says `ready`.

## Governance the bare skill lacks

The upstream workflow explains how to start local servers, drive a browser,
inspect UI state, capture screenshots, and review console logs. It does not
itself constrain which origin may be reached, how many browser actions may be
performed, or whether an operator approved the session. This overlay adds all
three controls:

1. **Exact-origin attenuation.** The caller supplies one URL origin such as
   `http://127.0.0.1:4173`. Paths, queries, fragments, wildcard hosts, and
   additional origins are rejected.
2. **Browser-action budget.** `max_browser_actions` is a positive integer from
   1 through 100 and is carried into the final packet for the host to enforce.
3. **Native approval gate.** runx records approval of the concrete origin, mode,
   and action budget before the overlay emits a ready decision.
4. **Receipt-emitting admission.** The digest verdict, attenuation, tool set,
   approval, and decision are sealed by the governed run.

## Authority boundary

- The wrapped instructions are admitted only when their exact sha256 matches
  the reviewed pin in `X.yaml`.
- The browser may navigate only within `allowed_origin`.
- `interaction_mode=read_only` excludes `browser.act` from the effective tool
  set; `interactive` includes it only after native approval.
- `max_browser_actions` caps browser interactions for the admitted session.
- The declared tool superset is explicit: `fs.read`, `process.spawn`,
  `browser.navigate`, `browser.inspect`, `browser.screenshot`,
  `browser.console`, and `browser.act`.
- Filesystem writes, arbitrary shell execution, credential reads, external
  network origins, and subagent spawning are not admitted.

The most restrictive authority wins. A host or graph may narrow this envelope;
the overlay never widens it. The final packet is an admission decision, not a
new capability grant.

## Procedure

1. Resolve the immutable `runx.overlay.wraps.path` from `X.yaml`.
2. Compute sha256 over the exact response bytes without normalizing line
   endings or transforming text.
3. Supply the prefixed digest, one exact origin, interaction mode, and action
   budget to the `governed` runner.
4. Review and approve the native gate for that concrete packet.
5. Continue only when `governance_decision.decision` is `ready`.
6. Enforce `effective_allowed_tools`, `allowed_origin`, and
   `max_browser_actions` when the downstream host runs the wrapped workflow.

## Refusals

- `runx.overlay.digest.required`: no digest was supplied.
- `runx.overlay.digest.stale`: the digest is malformed or differs from the pin;
  changed instructions are refused before approval.
- `runx.overlay.param.invalid`: origin, action budget, or interaction mode is
  missing or malformed.
- `runx.overlay.approval.missing`: a final decision was attempted without the
  native approval gate.

## Output

The final `governance_decision` uses schema `runx.skill_overlay.v1` and includes:

- immutable wrapped path and digest;
- exact origin, interaction mode, and action budget;
- effective scopes and tools;
- native approval gate and approved state;
- admission digest and `ready` decision.

## Harness

- `pinned-approved-seals` proves the immutable, attenuated, approved path seals.
- `digest-stale-refuses` proves changed instructions produce
  `runx.overlay.digest.stale` and seal a policy-denied refusal before approval.

## Install, run, verify

```bash
runx add <owner>/overlay-open-skill-1@<version> --registry https://api.runx.ai
runx skill <owner>/overlay-open-skill-1@<version> governed \
  -i resolved_digest=sha256:<reviewed-digest> \
  -i allowed_origin=http://127.0.0.1:4173 \
  -i max_browser_actions=12 \
  -i interaction_mode=interactive \
  --json -R ./receipts
runx verify --receipt <receipt.json> --json
```

The immutable upstream repository, file, commit, license, and digest are named
in `fixtures/evidence/upstream-provenance.json` so reviewers can recompute the
pin without copying the upstream instructions into this package.
