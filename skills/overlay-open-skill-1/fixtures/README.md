# Fixture replay

`pinned-approved-one-worktree-seals.yaml` is the portable standalone success
fixture. The authoritative refusal fixtures live in `X.yaml` under
`harness.cases`, because Runx 0.7.1 represents graph guard stops as sealed
`policy_denied` results in the inline package harness.

Run the complete contract with:

```text
runx harness ./skills/overlay-open-skill-1 --json
```
