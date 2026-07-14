# Harness evidence

Validated on 2026-07-14 from the repository root.

## Contract inspection

`runx skill inspect skills/overlay-open-skill-1 governed --json` returned
`status: ok`, selected the `governed` graph runner, and exposed all five declared
inputs.

The immutable upstream response returned HTTP 200 with 3,913 bytes. SHA-256 over
those exact bytes recomputed to:

`sha256:51b7349e77ec63b7744a6f63647e7566a0b4d2e301121cc10e8c2113af6556a2`

## Inline harness

The inline harness ran both graph cases and returned:

```json
{
  "status": "passed",
  "case_count": 2,
  "assertion_error_count": 0,
  "case_names": [
    "pinned-approved-seals",
    "digest-stale-refuses"
  ],
  "graph_case_count": 2
}
```

The approved case sealed `closed`. The stale-digest case emitted
`runx.overlay.digest.stale`, was stopped by the native graph guard before the
approval gate, and sealed `blocked` as required by the policy-denied
expectation.

The run produced two root receipts and four step receipts. All six receipts
passed `runx verify` against the ephemeral public verification key used for the
test. No signing seed or private credential was persisted.

On Windows, the released CLI currently attempts POSIX-style directory `fsync`
after writing receipts. The harness was therefore executed with a locally built
copy of the same repository revision whose Windows-only directory-sync call was
disabled; the patch did not change parser, graph, policy, harness, receipt, or
package behavior and was reverted immediately after compilation. Hosted
registry verification remains the authoritative cross-platform check for the
published package.

## Dogfood run

A real governed invocation paused at
`overlay-open-skill-1.browser-session.approval`, consumed an affirmative native
approval, and then sealed `closed` with reason code `graph_closed`.

- Receipt: `sha256:b40bc4ab5c11c12f9f99b7a6ea9993273cb03fd35eb750a8b1c2f878ad34afa3`
- Verification: valid
- Allowed origin: `http://127.0.0.1:4173`
- Interaction mode: `interactive`
- Browser-action budget: `12`

The verification key was supplied only to the local verifier. The ephemeral
private signing seed was cleared and was not written to the repository.
