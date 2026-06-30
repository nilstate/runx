# Escalation Judge Local Verification

- Package: `escalation-judge@0.1.0`
- CLI: `runx-cli 0.6.14`
- Inspect: `runx skill inspect ./skills/escalation-judge --json` returned `status: ok`.
- Harness: `runx harness ./skills/escalation-judge --json` passed all three cases.
- Escalation case: critical severity matched the named `executive_review` threshold, read the prior projection, appended a deterministic case id, and named `slack-notify` without dispatching it.
- Stop case: low severity matched no threshold, emitted no packet, opened no case, and returned `no_change`.
- Refusal case: missing policy rules returned `needs_human` without opening a case.
- State: the graph uses `data-store@0.1.2` in `read_projection -> decide -> append_event` order with a pinned `store_id`.
- Safety: the package never posts, sends, pages, or invokes the named target rail.
- Remaining publish proof: registry listing, hosted harness, clean install, dogfood receipt, and public receipt verification are produced after publish authorization.
