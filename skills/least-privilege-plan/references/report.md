# Least Privilege Plan Local Validation Report

## Result

`least-privilege-plan` is implemented as a new read-only first-party package
that can be published under an authenticated owner namespace. It accepts a
declared policy and bounded run-history packet, then returns one recommendation
per grant:

- `keep`
- `reduce`
- `revoke`
- `needs_human_review`

Each recommendation carries observed effects, unused scopes, receipt refs,
policy refs, rationale, and risk notes. The contract explicitly stops before
grant, policy, credential, provider, or repository mutation.

## Package

- Skill: `skills/least-privilege-plan/SKILL.md`
- Execution profile: `skills/least-privilege-plan/X.yaml`
- Runner: `plan`
- Version: `0.1.0`
- Skill digest:
  `a49e04cd076ebf3497cdc7d7a0dd7fadb3432a74b661dadf4edf916365725153`
- Profile digest:
  `31732944e603053b68d83b67248a60928edc6b684e8de8f939b46339f8490926`
- Validated base: `ec8e16af1e69af61f6686cb55e46b47b9b507262`
  (`cli-v0.6.13`)

## Harness Coverage

`over-broad-grants-produce-reductions` covers:

- reducing `repo.read + repo.write` to `repo.read` from two cited read effects;
- revoking an unused refund grant with no reserved policy purpose;
- stopping a reserved production deployment grant for human review.

`justified-grant-is-kept` covers:

- retaining `repo.read` when policy requires it and two receipts exercise it;
- preserving the residual authority in the risk notes.

Both fixtures sealed local receipts:

- `sha256:57aab827c43332d9f4ab747515277f701e28058d6661060e0ba123c8135fef8c`
- `sha256:8f1a93e7c2f1bd81698523f71e8cd4805961910d544993a25898c25122c7a21c`

An additional isolated run sealed:

- `sha256:9a75353edc00f030aeb9fc787e60a15a53a35c1c40010b3bdbfa32c1b348d5ad`
- `sha256:d8e5d9bf880b82fdec4fcc907a040fbeb811bd90da9d8bbd2df80fb8e1cea2bf`

Both isolated receipts passed production-mode verification with the matching
trusted Ed25519 public key. Their digest, content address, and signature checks
were valid with no findings. Single-receipt verification correctly left
receipt-tree lineage unverified.

## Checks Run

```sh
npx -y @runxhq/cli@0.6.13 --version
```

Result: `runx-cli 0.6.13`.

```sh
runx harness skills/least-privilege-plan --json
```

Result: passed, 2 cases, 0 assertion errors.

The registry publish gate also reran both inline cases and passed. The exact
publish-gate receipt ids are recorded in `evidence.json`, which is not part of
the published package digest.

The official catalog check accepted the package as `internal` and `canonical`.
The standalone fixtures remain checked in beside the inline publish cases.

```sh
corepack pnpm typecheck
```

Result: passed.

```sh
corepack pnpm test:fast
```

Result: 28 test files passed, 277 tests passed.

Focused compatibility checks also passed:

- official catalog and skill-ref checks: 12 tests;
- CLI receipt verification: 13 tests;
- runtime receipt signing: 7 tests.

Local publication and clean install also passed for:

```text
local-bounty/least-privilege-plan@0.1.0
```

The final local record resolved with:

```sh
RUNX_REGISTRY_DIR=<local-registry> \
  runx registry read local-bounty/least-privilege-plan \
  --version 0.1.0 \
  --json
```

## Direct Local Dogfood

A direct invocation, separate from the harness, reviewed
`support-release-policy-v4` against the bounded May 2026 run-history packet.
The flow paused for the native agent act, resumed with the typed plan, and
sealed receipt:

```text
sha256:5107a785eb7054030af4566dab08de73787d5099b8c8b07ce414da4c0f85b84b
```

The plan reduced `repo-access`, revoked `billing-access`, and held
`production-break-glass` for human review. The run remained read-only.

`references/verification.json` records the exact `runx verify` verdict:
digest, content address, and production-mode signature were valid with no
findings. Single-receipt lineage remained unverified by design.

## Hosted Handoff Commands

After the public package exists, a new user should be able to install it with:

```sh
runx add <owner>/least-privilege-plan@0.1.0 \
  --registry https://api.runx.ai \
  --json
```

They can inspect the published metadata with:

```sh
runx registry read <owner>/least-privilege-plan@0.1.0 \
  --registry https://api.runx.ai \
  --json
```

They can run the `plan` runner with a declared policy and bounded run-history
packet:

```sh
runx skill <owner>/least-privilege-plan@0.1.0 plan \
  --registry https://api.runx.ai \
  --input subject=<subject> \
  --input-json policy='<policy-json>' \
  --input-json run_history='<run-history-json>' \
  --receipt-dir <receipt-dir> \
  --json
```

If the native agent act pauses, resume it with the requested answer packet.
Then verify the sealed receipt with the trusted public key material returned by
the hosted flow:

```sh
runx verify --receipt <receipt.json> --json
```

## Remaining External Evidence

This local work is not a complete bounty delivery. The following actions remain
pending because they publish, push, or submit external state:

1. Claim the bounty through the approved Frantic agent flow.
2. Push the branch and open the public PR.
3. Publish the exact package name under the authenticated runx publisher.
4. Confirm the hosted registry harness passes.
5. Install and run the published package on a real bounded policy/history input.
6. Verify the hosted dogfood receipt with the returned public verification key.
7. Replace the null public artifact fields in `evidence.json` with immutable
   commit and registry URLs.

Local receipt verification passed with matching trusted key material. The
required final evidence should still use a hosted dogfood receipt because the
local harness receipts do not prove hosted execution or public package
availability.
