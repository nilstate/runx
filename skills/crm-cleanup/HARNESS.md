# CRM Cleanup harness evidence

Local pre-publish verification used `runx-cli 0.8.2` built from the same
`runxhq/runx` source revision as this package.

```text
runx harness skills/crm-cleanup --json
status: passed
case_count: 6
assertion_error_count: 0
```

Verified cases:

- `crm-cleanup-fetches-writes-and-reads-back`
- `crm-cleanup-noop-skips-write`
- `crm-cleanup-refuses-invented-evidence-without-write`
- `crm-cleanup-needs-transcript`
- `crm-cleanup-noop-sqlite`
- `crm-cleanup-writeback-sqlite`

The Codex Windows host already runs inside a Job Object, so the local semantic
harness used a worker built from the same source with only the nested Windows
Job Object attachment disabled. Skill code, graph execution, SQLite adapter,
assertions, receipts, and readback validation were unchanged. The hosted
registry harness is the independent acceptance authority after publication.
