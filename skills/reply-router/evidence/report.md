# reply-router Frantic #70 report

## Summary
- Added eply-router, a Runx skill for classifying inbound replies from sealed sends.
- Unsubscribe replies append a recipient-keyed suppression event with expected_version CAS and an idempotency key.
- Non-unsubscribe replies emit a typed unx.reply.routing.v1 routing decision for a later governed send-as run; the skill itself does not dispatch messages.
- Ambiguous or unsealed replies stop as 
eeds_agent without write or route.

## Published package
- Package: ohitmulani63-ops/reply-router@sha-a3bebc6
- Public URL: https://runx.ai/x/rohitmulani63-ops/reply-router
- Registry digest: $(@{status=success; registry=}.registry.publish.digest)
- Profile digest: $(@{status=success; registry=}.registry.publish.profile_digest)
- Trust tier: $(@{status=success; registry=}.registry.publish.trust_tier)

## Local harness validation
- Command: unx harness ./skills/reply-router
- Runtime: Docker Linux, unx-cli 0.6.14
- Result: passed
- Case count: 3
- Assertion errors: 0
- Cases: sealed_unsubscribe_suppression, sealed_interested_route, stop_ambiguous_or_unsealed

## Post-publish dogfood
- Command: unx skill rohitmulani63-ops/reply-router@sha-a3bebc6 --registry https://api.runx.ai -R ./skills/reply-router/evidence/dogfood-receipts -j ...
- Real input: unsubscribe reply from dogfood@example.test with a sealed original send receipt and suppression policy.
- Result: sealed
- Classification: unsubscribe
- Suppression write: committed through ppend_event
- Readback: projection version 1, event count 1
- Receipt ref: $receiptRef

## Verify verdict
- Command: unx verify --receipt <dogfood receipt json> --json
- Verdict: alid=true
- Digest status: $(@{schema=runx.verify_verdict.v1; receipt_id=sha256:f342f3f02527ee8cf9a7ea4e8d297a4911121d93b1cbda096f0e5ed7a4901b51; valid=True; digest=; content_address=; signature=; lineage=; findings=System.Object[]}.digest.status)
- Content address status: $(@{schema=runx.verify_verdict.v1; receipt_id=sha256:f342f3f02527ee8cf9a7ea4e8d297a4911121d93b1cbda096f0e5ed7a4901b51; valid=True; digest=; content_address=; signature=; lineage=; findings=System.Object[]}.content_address.status)
- Signature status: $(@{schema=runx.verify_verdict.v1; receipt_id=sha256:f342f3f02527ee8cf9a7ea4e8d297a4911121d93b1cbda096f0e5ed7a4901b51; valid=True; digest=; content_address=; signature=; lineage=; findings=System.Object[]}.signature.status)

## Why this matters
- The dangerous case is unsubscribe. The dogfood run proves the published package catches unsubscribe text and writes the suppression record before any later send can proceed.
- The suppression result records efore_version=0, fter_version=1, and idempotency_key=reply-router-dogfood-v0.
- The readback confirms the recipient projection now has one suppression event.
- The stop harness case protects against missing or unsealed original-send receipts.
