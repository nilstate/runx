# reply-router

A native runx skill that classifies inbound replies against a sealed send
receipt and either appends a recipient-keyed suppression event or emits a
bounded governed routing decision without sending.

## Develop

```bash
runx harness ./skills/reply-router --json        # run the harness cases
runx skill ./skills/reply-router --json          # run the default graph runner
```

## Publish

```bash
runx login --provider github --for publish
runx registry publish ./skills/reply-router/SKILL.md --registry https://api.runx.ai
```

## Harness cases

- `sealed_unsubscribe_suppression` — sealed receipt + unsubscribe text →
  suppress (append_event to data-store, no routing decision).
- `stop_ambiguous_or_unsealed` — unsealed receipt + ambiguous text →
  needs_agent (no suppression write, no routing decision).
