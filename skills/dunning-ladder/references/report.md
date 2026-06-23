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

