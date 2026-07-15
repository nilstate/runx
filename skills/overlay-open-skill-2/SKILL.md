---
name: overlay-open-skill-2
description: Govern an immutable open-ecosystem skill finder with a pinned digest, owner-scoped discovery, an operator approval gate, and a receipt-bound single-search authorization.
---

# Governed Skill Discovery Overlay

Use this overlay when an operator wants to search the open skill ecosystem but
does not want borrowed instructions to gain installation authority or silently
change after adoption. The overlay pins the wrapped instructions, narrows one
invocation to one owner-scoped search, asks for approval over the normalized
query, and records the approved decision in a sealed runx receipt.

The wrapped `SKILL.md` is referenced, never copied or edited. A trusted resolver
must compute `resolved_digest` from the immutable public bytes. If that digest
does not match the pin, the graph raises `runx.overlay.digest.stale` and refuses
before the approval step.

## Added governance

The bare upstream skill can search, recommend, and install extensions. This
overlay deliberately attenuates that authority to discovery only:

1. `admit` verifies the immutable digest and validates a bounded query.
2. The search is restricted to one explicit public repository owner, at most
   six safe query tokens, and one fixed argument vector.
3. `approve-search` is a native runx approval gate over that exact owner, query,
   and command plan.
4. `record-search` consumes the bound approval decision and emits a
   `runx.skill_overlay.skill_search_act.v1` single-effect authorization.

The package never installs or updates a skill, never writes to the filesystem,
and never executes the search itself. A consuming host must atomically consume
the authorization's idempotency key, execute only its recorded argument vector,
retain exit status and redacted output, and bind that effect receipt to the
authorization.

## Inputs

- `objective`: why discovery is needed.
- `resolved_digest`: sha256 recomputed from the immutable wrapped `SKILL.md`.
- `query`: one to six bounded search tokens.
- `owner`: one explicit public repository owner to search.
- `operation`: must be `find`.
- `allow_install`: must be `false`.
- `max_results`: must be an integer from 1 through 10; the consuming host must
  retain no more than this many normalized result records.

## Exact authority

When admitted, the only releasable command is represented as an argument
vector, never as a caller-provided shell string:

```text
npx --yes skills find <query tokens...> --owner <owner>
```

The authorization allows only `shell.exec` under `web.read` and
`skill.discovery` scopes. It records explicit denials for installation,
updates, filesystem writes, credential reads, arbitrary owners, command
chaining, redirection, interactive prompts, and additional commands.

## Refusal conditions

Refuse before approval when any of these is true:

- the resolved digest is missing, malformed, or differs from the pin;
- `operation` is not exactly `find`;
- `allow_install` is not exactly `false`;
- the owner is missing or is not a bounded public owner name;
- the query is empty, has more than six tokens, or contains shell syntax;
- `max_results` is outside the integer range 1 through 10.

Digest drift raises `runx.overlay.digest.stale`. Other boundary failures use a
specific `runx.overlay.attenuation.*` diagnostic. A refusal never reaches the
approval or authorization step.

## Operator procedure

1. Fetch the immutable wrapped source, recompute sha256, and retain the public
   source URL and digest evidence.
2. Supply the bounded inputs and run this package.
3. Review the normalized owner, query tokens, result cap, and exact argv at the
   native approval gate.
4. Approve only when the outbound search is appropriate.
5. Inspect the sealed receipt and single-effect authorization.
6. If a host consumes it, atomically register the idempotency key, execute only
   the exact argv without a shell interpreter, redact secrets from output, cap
   normalized records at `max_results`, and retain an effect receipt.

## What the receipt proves

The receipt proves which immutable instructions were admitted, which authority
was narrowed, which exact search was approved, and which single-effect
authorization was issued. It does not prove that the host executed the command
or that any result is safe to install. Installation requires a separate,
independently governed decision.
