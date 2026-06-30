# Reply Router Validation Report

Observed on 2026-06-29 with Node.js v24.12.0 and runx CLI 0.6.14.

## Verified locally

- The official CLI parses the profile and validates its graph edges.
- The required `sealed_unsubscribe_suppression` input classifies as
  `unsubscribe`/`suppress` only when the receipt is sealed, checksummed, and its
  audience matches the inbound sender.
- The suppression path performs a recipient-keyed `read_projection`, uses the
  returned version as `append_event.expected_version`, and commits version
  `0 -> 1` through the data-store local adapter.
- The suppression formatter emits `runx.reply.routing.v1` with
  `send_side_effects: none`.
- The required `stop_ambiguous_or_unsealed` case reaches the stop branch and the
  inline harness reports that case as passing with `needs_agent`.
- Both JavaScript runners pass `node --check`.

## Commands and observed status

```text
runx --version
PASS: runx-cli 0.6.14

runx harness ./skills/reply-router --json
STRUCTURE PASS; OFFLINE RESOLUTION BLOCKED:
registry:runx/data-store@0.1.2 requires a configured local or hosted registry.

# Local-equivalent graph run using the same checked-in data-store@0.1.2 source
runx harness ./skills/reply-router --json
PARTIAL PASS:
- stop_ambiguous_or_unsealed: passed
- sealed_unsubscribe_suppression: data-store branch executed, then the Windows
  receipt store returned "The parameter is incorrect. (os error 87)" while
  sealing the receipt.

node skills/reply-router/graph/classify-reply/run.mjs
PASS: classification=unsubscribe, route=suppress, trusted=true

node skills/data-store/tools/data/local/run.mjs # read_projection
PASS: status=read, projection.version=0

node skills/data-store/tools/data/local/run.mjs # append_event
PASS: status=committed, before_version=0, after_version=1

node skills/reply-router/graph/emit-result/run.mjs
PASS: schema=runx.reply.routing.v1, action=suppressed,
send_side_effects=none

node --check skills/reply-router/graph/classify-reply/run.mjs
node --check skills/reply-router/graph/emit-result/run.mjs
PASS
```

The temporary local dependency substitution used for the equivalent Windows
run was reverted. The checked-in graph pins both data-store calls to
`registry:runx/data-store@0.1.2`.

## Required hosted follow-up

Before bounty delivery, run the public registry publish harness on Linux,
publish `reply-router@0.1.0`, install it into a clean workspace, run both harness
cases again, dogfood one sealed unsubscribe, and record `runx verify` output.
No hosted result is claimed by this report before those commands complete.
