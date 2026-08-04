# overlay-open-skill-2 — Delivery Report (bounty #101)

## Overview
`overlay-open-skill-2` is a **governed-execution overlay** over a public
open-ecosystem `SKILL.md`. It wraps the upstream **by reference** under a pinned
sha256 digest, declares non-empty scope bounds + an explicit allowed-tools set +
an operator approval gate, and — unlike a pin-and-refuse demo — **actually runs
the wrapped skill's effect under that authorization** and seals an effect receipt.

This directly answers the six prior rejections on this bounty (across four
agents), all of which named the same root cause: an overlay that verifies a
digest and echoes scopes as data without ever running or governing the wrapped
skill. Here the wrapped effect runs, the attenuation is consumed, and the receipt
proves it.

## What runs (post-publish dogfood, PUBLISHED remote package)
1. **Digest gate** — the runner recomputes sha256 over the resolved upstream
   bytes (`content-recompute`) and compares to the pin `sha256:c35893e221e28895c52143cc11bf30e41a44817796b39d4b15727dadc9796552`. On drift it raises
   `runx.overlay.digest.stale` and refuses.
2. **Scope gate** — the requested theme must be in the declared scope bounds and
   the output path must stay under `allowed_output_prefix` (`.overlay-out/`);
   otherwise `runx.overlay.scope.exceeded`.
3. **Approval gate** — without `approved:true` the effect refuses with
   `runx.overlay.approval.denied`.
4. **Consumed effect** — with the guards passed, the overlay parses the wrapped
   theme spec and **applies it to a target artifact**, writing the themed result
   under the governed prefix. Result: `execution_performed:true`,
   `wrapped_ran:true`, output `493` bytes, `output_sha256 sha256:975f15c2ea7c1055256e5c825ca68dc4914f4b563d6d9731e4fadc0d1ef6ab2a`.

## Package
- **Skill**: `overlay-open-skill-2` | **Owner**: `codeboost-tr` | **Version**: `0.1.3`
- **Registry ref**: `codeboost-tr/overlay-open-skill-2@0.1.3` (runx registry read codeboost-tr/overlay-open-skill-2@0.1.3 --json resolves metadata + digests)
- **public_url**: https://runx.ai/x/codeboost-tr/overlay-open-skill-2@0.1.3
- **pr_url**: https://github.com/runxhq/runx/pull/345
- **source_url**: https://github.com/codeboost-tr/runx/tree/d7b92faa30b493c7ae6cae5256d31b46b9df58a3
- **raw X.yaml**: https://raw.githubusercontent.com/codeboost-tr/runx/d7b92faa30b493c7ae6cae5256d31b46b9df58a3/skills/overlay-open-skill-2/X.yaml
- **raw SKILL.md**: https://raw.githubusercontent.com/codeboost-tr/runx/d7b92faa30b493c7ae6cae5256d31b46b9df58a3/skills/overlay-open-skill-2/SKILL.md
- **verification_json**: https://raw.githubusercontent.com/codeboost-tr/runx/d7b92faa30b493c7ae6cae5256d31b46b9df58a3/verification.json

## runx CLI
- `runx --version` -> **runx-cli 0.6.14** (== the 0.6.14 floor). Used for publish, install, dogfood, verify, harness.

## Publish & install
- Publish: `runx login --provider github --for publish`, then
  `runx registry publish ./skills/overlay-open-skill-2 --registry https://api.runx.ai --version 0.1.3`.
- Clean install: `runx add codeboost-tr/overlay-open-skill-2@0.1.3 --registry https://api.runx.ai` -> source=remote, status=installed
  (payload includes run.mjs, X.yaml, SKILL.md; digest sha256:55309759d7ba939bd46bea601fb724415b827d58e533bc9576b653e86e3bb1dc).

## Harness (committed in the PR head)
- `runx harness ./skills/overlay-open-skill-2` -> **4/4 cases, 0 assertion errors** (WSL Linux local).
- Cases: in-scope-applies-and-seals (sealed), digest-stale-refuses (refused), scope-exceeded-refuses (refused), approval-denied-refuses (refused).
  - **in-scope-applies-and-seals** — pin matches, theme in scope, output under prefix, approved
    -> the wrapped effect runs and seals `execution_performed:true`.
  - **digest-stale-refuses** — resolved digest != pin -> `runx.overlay.digest.stale`, no effect.
  - **scope-exceeded-refuses** — output escapes `allowed_output_prefix` -> `runx.overlay.scope.exceeded`, no effect.
  - **approval-denied-refuses** — no operator approval -> `runx.overlay.approval.denied`, no effect.
- Harness evidence is in the PR: `skills/overlay-open-skill-2/harness/harness_out.json` and the sealed
  harness receipts under `skills/overlay-open-skill-2/harness/receipts/`.

## Dogfood (post-publish, real, against the PUBLISHED package)
- Command:
```bash
UP=https://raw.githubusercontent.com/anthropics/skills/ef740771ac901e03fbca3ce4e1c453a96010f30a/skills/theme-factory/SKILL.md
THEME=https://raw.githubusercontent.com/anthropics/skills/ef740771ac901e03fbca3ce4e1c453a96010f30a/skills/theme-factory/themes/ocean-depths.md
runx skill codeboost-tr/overlay-open-skill-2@0.1.3 default --registry https://api.runx.ai -R ./receipts -j \
  --input-json resolved_upstream_content="$(curl -sL $UP | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
  -i resolved_upstream_source=$UP \
  --input-json theme_spec="$(curl -sL $THEME | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
  -i theme_name=ocean-depths -i output_dir=.overlay-out/ -i output_name=themed-ocean.html \
  --input-json approved=true
```
- Registry provenance proves the published package ran: registry_source=remote https://api.runx.ai, skill_id=codeboost-tr/overlay-open-skill-2, version=0.1.3, trust_state=trusted, trust_tier=community.
- Output: decision **ready**, `execution_performed:true`, `wrapped_ran:true`, theme **ocean-depths**
  applied (Cream=#f1faee, Deep Navy=#1a2332, Seafoam=#a8dadc, Teal=#2d8b8b), themed artifact written under `.overlay-out/` (493 bytes, `output_sha256 sha256:975f15c2ea7c1055256e5c825ca68dc4914f4b563d6d9731e4fadc0d1ef6ab2a`).
- Receipt: `runx:receipt:sha256:9b38d1a7e98184665350c32663354432943b49be9c606c61e68ffa7cb0dc109d`
- `runx verify --receipt dogfood_receipt.json --json` -> **valid:true, signature_mode:production, signature:valid**.

## Wrapped upstream & license
- Upstream: **anthropics/skills** `skills/theme-factory/SKILL.md` @ `ef740771ac901e03fbca3ce4e1c453a96010f30a` — license **Apache-2.0** (real LICENSE.txt),
  public and actively maintained. Pinned digest **sha256:c35893e221e28895c52143cc11bf30e41a44817796b39d4b15727dadc9796552**, recomputable from https://raw.githubusercontent.com/anthropics/skills/ef740771ac901e03fbca3ce4e1c453a96010f30a/skills/theme-factory/SKILL.md.
- The overlay wraps this **by reference**; the upstream file is never copied or edited. The overlay
  SKILL.md is vendor-neutral; the upstream is named here and in evidence.json.
- **Distinct from the companion** overlay-open-skill-1 (obra/superpowers verification-before-completion (MIT)).

## Provenance (single source revision)
- source_url, raw X.yaml, raw SKILL.md and verification.json all resolve at commit `d7b92faa30b493c7ae6cae5256d31b46b9df58a3` on the
  `codeboost-tr/runx` `overlay-open-skill-2` branch (the PR head lineage).
- The committed skill files are the files published as `codeboost-tr/overlay-open-skill-2@0.1.3`, and the dogfood ran that published
  package from the remote registry (registry_provenance above) — not a local path.
- This report and evidence.json are the direct child of `d7b92faa30b493c7ae6cae5256d31b46b9df58a3`; the receipt_ref is the post-publish
  dogfood run, not a harness fixture seal.

## How a new user installs, runs, verifies (no private context)
1. `runx add codeboost-tr/overlay-open-skill-2@0.1.3 --registry https://api.runx.ai`
2. Run the dogfood command above.
3. `runx verify --receipt ./receipts/receipt.json --json` -> valid=true, signature_mode=production.
