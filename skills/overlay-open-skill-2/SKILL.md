---
name: overlay-open-skill-2
description: A governed-execution overlay that wraps an open-ecosystem SKILL.md by reference under a pinned sha256 digest, enforces scope bounds, an explicit allowed-tools set, and an operator approval gate, then runs the wrapped skill's effect under that authorization and seals an effect receipt — refusing when the upstream content drifts from the pin.
license: Apache-2.0
---

# Governed Overlay for an Open-Ecosystem Skill

The open skill ecosystem publishes plain `SKILL.md` instruction files that any
agent can read and follow. Those files carry no scope bounds, no tool allowlist,
and no protection against an upstream edit silently changing what a skill does
after it has been adopted. This overlay closes that gap without ever editing or
copying the upstream file.

The overlay pins the upstream by **reference plus a sha256 digest**, declares the
scope it is allowed to touch and the exact set of tools the wrapped skill may
use, and — crucially — **actually runs the wrapped skill's effect under that
authorization**, sealing a receipt that proves the governed work happened. It is
not a pin-and-refuse demo: when the guards pass, real bytes are produced under a
governed output prefix and their digest is recorded.

## What it governs

- **Digest pin.** The upstream is resolved (fetched live in a real run, or read
  from a resolver-supplied digest in the deterministic harness) and its sha256 is
  compared to the pinned digest. If they differ, the overlay raises
  `runx.overlay.digest.stale` and refuses rather than running changed
  instructions unseen.
- **Scope bounds.** The requested unit of work must fall inside the declared
  scope bounds, and any file the effect writes must stay under
  `allowed_output_prefix`. An out-of-scope request raises
  `runx.overlay.scope.exceeded` and refuses.
- **Explicit allowed tools.** Every tool the wrapped skill may touch is named
  (`fs.read`, `fs.write`, `net.fetch`); there is no wildcard.
- **Approval gate.** The governed effect only runs when an explicit operator
  approval flag is present. Otherwise it raises `runx.overlay.approval.denied`.

## What it does when the guards pass

The overlay consumes the attenuation: it reads the wrapped skill's specification,
performs the wrapped effect within the granted scope, and writes the result under
the governed output prefix. The sealed receipt records:

- `execution_performed: true` and `wrapped_ran: true`;
- the `authorization` it ran under (pinned digest, resolution mode, granted
  scope, allowed tools);
- the `effect` it produced (the act performed, the output path, the
  `output_sha256` of the bytes written, and the byte count).

## Inputs

| input | required | meaning |
|-------|----------|---------|
| `resolved_upstream_url` | one of these three | raw URL of the upstream to fetch and hash live |
| `resolved_upstream_path` | one of these three | local snapshot of resolved upstream to read and hash |
| `resolved_digest` | one of these three | sha256 the resolver already computed |
| `theme_name` | yes | the in-scope unit of work to run |
| `theme_spec` | yes | the wrapped skill's specification the effect consumes |
| `artifact` | no | the target the effect is applied to |
| `output_dir` / `output_name` | no | where the governed output is written (under the prefix) |
| `approved` | yes | operator approval flag; must be `true` to run the effect |

## Guarantees

- The upstream file is **never copied or edited**; only its reference and digest
  are pinned.
- No effect runs on a stale pin, an out-of-scope request, or without approval.
- Every non-refused run seals an effect receipt whose `output_sha256` a reviewer
  can reproduce from the recorded inputs.

## Verifying a run

Run the skill on a real input and pass the resulting receipt to
`runx verify --receipt ./receipts/receipt.json --json`; a passing verdict plus the
`execution_performed: true` receipt is the proof that the governed effect ran
under the pinned authorization.
