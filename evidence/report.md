# reply-router Delivery Report

## Skill
- **Name:** reply-router
- **Registry:** armstrongsam25/reply-router@sha-ad0fc216e139
- **Public URL:** https://runx.ai/x/armstrongsam25/reply-router

## Harness
- **Local:** 2/2 passed, 0 errors
- **Hosted:** 2/2 passed, 0 errors
- Cases: sealed_unsubscribe_suppression (sealed), stop_ambiguous_or_unsealed (failure/stop)

## Dogfood
- **Input:** Unsubscribe reply ("Please unsubscribe me from this mailing list.")
- **Output:** Classified as unsubscribe (0.96 confidence), suppression event appended (v0 to v1)
- **Receipt:** sha256:3205745863e359e3b60a9dcfdca2fb437d37d19f0d03de1876db09a109351c5c
- **Verify:** valid (signature, digest, content address all valid)

## PR
https://github.com/runxhq/runx/pull/245

## runx version
runx-cli 0.6.16
