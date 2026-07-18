# Incident commander delivery report

This delivery publishes `mossony/incident-commander@sha-f94caa7b3588` and proves a real advance over a declared SEV-2 incident on the shipped RunX agency spine. The public registry page is <https://runx.ai/x/mossony/incident-commander@sha-f94caa7b3588> and the public review is <https://github.com/runxhq/runx/pull/347>.

## What shipped

- The package name is exactly `incident-commander`, owned by `mossony`, with immutable registry digest `e1a9dcb860ecea3d1d7c759366eb5c0abb95f7e6ce92c0056dd110aae0ff5365` and profile digest `c3c2c5f140a65033f41834ebe71324e3ba57b8c97797e06413367d2cebd57bc7`.
- The public PR contains `skills/incident-commander/X.yaml`, `SKILL.md`, the deterministic enforcement runner, both fixtures, inline harness declarations, packet schemas, and harness evidence.
- The skill is intentionally the thin incident judgment layer. It consumes folded state, refuses invented roster members or evidence, names only bounded communication plans, and leaves persistence and contention to `agency`.
- Communication remains dispatch-by-naming. A roster-matched approval may name `send-as` or `slack-notify`, but this package performs no provider send and never marks communication delivered without a linked downstream receipt.

## Reproducible validation

- `runx --version` returned `runx-cli 0.7.1`; that binary ran publication, install, dogfood, and receipt verification.
- `runx harness ./skills/incident-commander -R ../runx-evidence/local-harness --json` passed 2/2 graph cases with zero assertion errors.
- The hosted registry harness is green at 2/2 on the public package page and links receipt `sha256:f88f55b5b502bcaa50ed9177c1a7bf463de7142b37a4dbef53cd3d1f16928a12`.
- `runx registry read mossony/incident-commander@sha-f94caa7b3588 --registry https://api.runx.ai --json` resolved the exact owner, package name, version, digests, publisher, and `advance` runner.
- A clean `runx add mossony/incident-commander@sha-f94caa7b3588 --registry https://api.runx.ai --json` installed `X.yaml`, `SKILL.md`, and the immutable profile into an empty target.
- Repository validation passed `pnpm contracts:schemas:check`, `pnpm catalog:check`, `pnpm typecheck`, and `pnpm test:fast` with 176/176 tests.

## Harness behavior

- `status-update-awaits-then-roster-approval-advances` first returns `awaiting_approval` with a non-executable `send-as` plan bound to the stakeholder audience and content digest. A follow-up carrying approval principal `incident:comms:morgan` advances and seals the turn.
- `assign-without-named-roster-owner-needs-agent` withholds `caller.answers`, blocks in the ops-desk sub-step, returns `needs_agent`, and names no run.
- The observed incident severity is `SEV-2`; scope is `checkout-api`; the named communications plan targets `stakeholders:checkout-api` and binds digest `sha256:4e44f31f628799267f0957c554b8c47d90d2eabf41e5a84248941d28c45955ae`.

## Real agency-spine dogfood

- The driver opened case `incident-112-mossony-20260718` in a SQLite event stream using the shipped `skills/agency` runner and a fixed commander, responder, and communications roster.
- The first agency advance read and folded the real stream, selected `mossony/incident-commander@sha-f94caa7b3588` as the commander member, and CAS-appended turn 1 with idempotency key `incident-112-mossony-20260718:turn:1:agency-dispatch-commander`.
- The separately governed published member run produced production-signed receipt `runx:receipt:sha256:bf3149287c60d6562e3d55d36e3c4bff296c7a3b9dafcc1bb3ba70c01e274353`.
- The second agency advance accepted that exact receipt as `member_result`, read events at version 2, folded `expected_version=2`, planned turn 2, and committed `append_event` from version 2 to 3 with idempotency key `incident-112-mossony-20260718:turn:2:agency-bind-member-receipt`.
- The raw bind checkpoint contains both `graph_inputs.member_result.receipt_ref` and the persisted turn event carrying the same member receipt. It also contains the `read_events`, reducer, plan, and `append_event` outputs; it is not an all-true assertion summary.
- The outer agency tree rooted at `runx:receipt:sha256:fc683f33c30cca0e194808ade4e201897cbfa04fff2a5ea8b7fa476de3990db2` verifies across six production-signed receipts with no missing parent and no findings.
- The member tree verifies across five production-signed receipts with no missing parent and no findings. All 19 raw receipt documents, the four raw graph-state checkpoints, and the three ledgers are committed under `receipts/`.

## Independent verification

The one-run signing seed was generated in memory, never printed, and never persisted. The public verification identity is:

```text
kid=mossony-frantic-112-20260718
algorithm=Ed25519
public_key_base64=UlNOg2tuiyOkDf6A2Dd/H0V30n5Z0cdqp4+fwiElocU=
```

Verify the required post-publish member receipt:

```bash
RUNX_RECEIPT_VERIFY_KID=mossony-frantic-112-20260718 \
RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64='UlNOg2tuiyOkDf6A2Dd/H0V30n5Z0cdqp4+fwiElocU=' \
runx verify \
  --receipt evidence/frantic-112-incident-commander/receipts/sha256-bf3149287c60d6562e3d55d36e3c4bff296c7a3b9dafcc1bb3ba70c01e274353.json \
  --json
```

Verify the complete outer agency bind tree:

```bash
RUNX_RECEIPT_VERIFY_KID=mossony-frantic-112-20260718 \
RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64='UlNOg2tuiyOkDf6A2Dd/H0V30n5Z0cdqp4+fwiElocU=' \
runx verify \
  'sha256:fc683f33c30cca0e194808ade4e201897cbfa04fff2a5ea8b7fa476de3990db2' \
  --receipt-dir evidence/frantic-112-incident-commander/receipts \
  --json
```

The expected verdict is `valid: true`, `signature_mode: production`, six receipts, `parent_missing: null`, and an empty findings list. `agency-spine-results.json` is a navigation index; reviewers should inspect the raw graph-state and sealed receipt files it names.

## New-user flow

```bash
runx add mossony/incident-commander@sha-f94caa7b3588 --registry https://api.runx.ai
runx registry read mossony/incident-commander@sha-f94caa7b3588 --registry https://api.runx.ai --json
runx skill mossony/incident-commander@sha-f94caa7b3588 --registry https://api.runx.ai --json
```

A new user needs no private source or private credentials to inspect the package, install it, run it, fetch the raw delivery evidence, or verify the committed production signatures.
