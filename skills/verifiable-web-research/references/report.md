# Verifiable Web Research Delivery Report

## Package

- Registry ref: `jienigoto/verifiable-web-research@sha-f0d326500848`
- Public URL: https://runx.ai/x/jienigoto/verifiable-web-research@sha-f0d326500848
- Source PR: https://github.com/runxhq/runx/pull/112
- Package digest: `7547a9783368d97b03be077d5ba822b3a817a6394634756091e9507f47775882`
- Profile digest: `6230275c1ddf69851b58e1028f002ff9bf83ffc61c9311a948889f857ddc83e6`

## What the Skill Does

`verifiable-web-research` builds an auditable research packet from captured
source snapshots. It emits claim text, source URLs, final URLs, access times,
content digests, exact extracts, confidence reasoning, and replay steps. The
runner does not reach the network, so harness runs are deterministic and safe.

## Verification Summary

- `runx --version` returned `runx-cli 0.6.13`.
- `node --test skills/verifiable-web-research/test.mjs` passed 4 tests.
- `runx harness ./skills/verifiable-web-research --receipt-dir .runx-delivery-receipts --json` passed 2 declared cases.
- `runx registry publish ./skills/verifiable-web-research/SKILL.md --registry https://api.runx.ai --json` published the package.
- `runx registry read jienigoto/verifiable-web-research@sha-f0d326500848 --registry https://api.runx.ai --json` resolved the registry package.
- `runx add jienigoto/verifiable-web-research@sha-f0d326500848 --registry https://api.runx.ai --json` installed the package from the remote registry.
- The versioned public page returned HTTP 200.

## Receipt Proof

Primary receipt:

`runx:receipt:sha256:e3d0d862edde1959bf7e14540554f9d8359f8b1b49eb500c02eae5601979333e`

Verification command:

```bash
RUNX_RECEIPT_VERIFY_KID=local-harness-key \
RUNX_RECEIPT_VERIFY_ED25519_PUBLIC_KEY_BASE64=IVL40Zt5HSRFMkLhXy6rbLfP+ntqXtMAl5YOBpiB2xI= \
runx verify --receipt-dir .runx-delivery-receipts \
  sha256:e3d0d862edde1959bf7e14540554f9d8359f8b1b49eb500c02eae5601979333e \
  --json
```

Result: `valid: true`.

The negative-path harness receipt
`sha256:c31b620b06736a5bb7507c8353619612618a440d5c41737d2780ccc1ff20f626`
also verifies with `valid: true`.

## Notes

The registry skill dogfood run was admitted and sealed under
`jienigoto/verifiable-web-research@sha-f0d326500848`. On this Windows/WSL
machine, the registry dogfood receipt file did not remain readable across the
receipt directory boundary, so the durable receipt proof submitted here is the
harness receipt set.
