# Dunning Ladder verification report

- Built with `runx-cli 0.6.13`.
- Doctor reports zero errors and warnings.
- Both required harness cases pass.
- The within-cap case chooses step 2 from a supplied cadence.
- The reminder is only a gated proposal for `send-as`.
- Content is represented by a deterministic digest.
- No email, charge, suspension, or receivable mutation occurs.
- The cadence cap is a hard upper bound.
- At the cap, the run fails and directs operator escalation.
- A record not explicitly overdue is refused.
- Inputs contain bounded references rather than private payment details.
- Human approval is required before any reminder is sent.
- Published registry ref: `luismireles12/dunning-ladder@sha-c3ca3eb81b17`.
- Public adoption page: https://runx.ai/x/luismireles12/dunning-ladder@sha-c3ca3eb81b17.
- Clean installation resolved the same package and profile digests.
- Post-publish dogfood selected step 2 under a cap of 3.
- Receipt `sha256:d3da84c3ef48e3d67a5f0e5c0a89f9025e0ff485962d4af4f8de92c6b99a727b` verifies as valid with no findings.
