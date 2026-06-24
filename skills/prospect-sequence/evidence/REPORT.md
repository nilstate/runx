# prospect-sequence delivery report

## Summary

Adds `prospect-sequence`, a runnable runx skill that researches a prospect from explicit public allowlisted sources, drafts a sourced three-touch outreach sequence, and returns a gated send proposal without sending anything.

## Safety boundary

- Accepts only public `https://` sources.
- Requires each source host to be present in `source_allowlist`.
- Refuses localhost, loopback, private IPv4 ranges, and link-local ranges.
- Produces `send_proposal.status = proposal_only`; it never sends email or performs outreach.

## Verification

Manual deterministic checks are included in `evidence/`:

- `manual-success.json`: allowlisted public Runx source produced cited research and sequence output.
- `manual-refusal.stderr.txt`: loopback/non-https source refused.
- `verification.json`: records local harness and hosted publish attempts.

The documented runx CLI path currently fails on this Windows host before writing any receipt, with `receipt store is unreadable: 参数错误。 (os error 87)`. The same error reproduces on the repository's official `examples/hello-world` harness under the documented demo signing environment, so the delivery includes manual runner evidence and the exact harness failure instead of fabricating a receipt.
