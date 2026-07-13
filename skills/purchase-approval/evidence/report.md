# Purchase Approval Harness Report

- Tested with `runx-cli 0.7.0`, above the required `0.6.14` floor.
- Ran `runx harness skills/purchase-approval --json` from the repository root.
- The in-policy case sealed after producing an approved decision and a bounded
  480 USD `AttenuationRequest` for the declared vendor and scope.
- The over-budget case stopped at `needs_agent`; it supplied neither caller
  answers nor human confirmation and therefore emitted no spend ceiling.
- Both cases use the same typed purchase request, procurement policy, remaining
  budget, and requested-scope boundaries described by the public skill contract.
- The skill performs judgment only. Minting, reserving, settling, and moving
  funds remain the responsibility of a downstream accepting runner.

