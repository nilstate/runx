# CLI Exit Codes

Runx uses a small exit-code surface so scripts can branch without parsing
human output.

## Exit Code 0: Success

The command completed successfully. For `runx skill`, `runx harness`, and
inspection commands, the requested work or read operation succeeded.

Common follow-up:

```bash
runx inspect <receipt-id>
```

## Exit Code 1: Failure

The command ran but failed, was denied by policy, hit an invalid operation, or
found invalid requested output.

Common fixes:

- Read the stderr message first; it should name the failing command or policy.
- Re-run with `--json` when the command supports it.
- For harness failures, inspect `assertionErrors` in the JSON output.

## Exit Code 2: Needs Resolution

The run paused because it needs input, approval, or cognitive work before it
can continue. In production mode (`RUNX_PRODUCTION=1`), unresolved cognitive
work is treated as a non-resumable failure but keeps exit code 2 so automation
can distinguish it from ordinary command failure.

Common fixes:

```bash
runx resume <run-id>
runx resume <run-id> --answers answers.json
runx skill <skill-dir> --answers answers.json
```

For required input, pass the missing `--input` value or the corresponding
kebab-case CLI flag.

## Exit Code 64: Usage

The command shape is not supported. This usually means the first positional
argument is not a known command or the command is missing its required action.

Common fixes:

```bash
runx --help
runx skill <skill-ref>
runx harness <fixture.yaml>
```
