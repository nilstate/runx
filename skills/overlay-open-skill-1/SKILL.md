---
name: overlay-open-skill-1
description: Govern an immutable open-ecosystem worktree skill with a pinned digest, exact one-worktree attenuation, an operator approval gate, and a receipt-bound single-effect authorization.
---

# Governed Worktree Creation Overlay

Use this overlay when an open-ecosystem skill proposes creating a Git worktree
and the operator needs more than trusted prose. The overlay pins the borrowed
instructions, narrows one invocation to one repository and one worktree, asks
for approval over the normalized plan, and records the approved decision in a
sealed runx receipt.

The wrapped `SKILL.md` is referenced, never copied or edited. A trusted resolver
must compute `resolved_digest` from those public bytes. If that supplied digest
no longer matches the pin, the graph refuses before the approval step.

## Added governance

The bare upstream instructions explain a good worktree workflow. This overlay
adds authority that a caller can actually consume:

1. `admit` validates the immutable digest and normalizes an exact worktree
   creation plan.
2. The plan is attenuated to one repository root, one `.worktrees` root, one
   direct child path, one branch, one start commit, and one fixed argument
   vector.
3. `approve-create` is a native runx approval gate over that normalized plan.
4. `record-act` recomputes the native approval decision key over the exact plan,
   consumes that approval artifact, and emits a
   `runx.skill_overlay.worktree_act.v1` single-effect authorization. The graph
   receipt records the pin, attenuation, gate, decision, and closure.

This package deliberately does not execute the authorization and does not claim
that a worktree exists. A host may hand it to an existing Git execution surface,
but the host must atomically consume its `idempotency_key` in an idempotency
registry, execute only the exact recorded `argv`, and bind the resulting effect
receipt and readback to that key.

## Inputs

- `objective`: why the isolated workspace is needed.
- `resolved_digest`: sha256 recomputed by a trusted resolver from the immutable
  public wrapped `SKILL.md` bytes.
- `repo_root`: absolute root of the normal Git checkout.
- `worktree_root`: the exact absolute `<repo_root>/.worktrees` directory.
- `worktree_path`: one direct child of `worktree_root` for the new checkout.
- `branch_name`: a bounded feature, fix, chore, docs, test, refactor, or codex
  branch name.
- `start_commit`: an immutable 40- or 64-hex Git object id.
- `mechanism`: must be `git_fallback` for this package version.
- `max_worktrees`: must be exactly `1`.

## Exact authority

When admitted, the only releasable command is represented as an argument
vector, never a caller-provided shell string:

```text
git -C <repo_root> worktree add --no-checkout -b <branch_name> <worktree_path> <start_commit>
```

The authorization records the host tools `git.status`, `git.diff_name_only`,
and `shell.exec` and records denials for commit, push, worktree removal,
arbitrary filesystem writes, network access, credential access, `.gitignore`
edits, command chaining, redirection, and more than one worktree. These are
ticket terms for the consuming host; this non-executing graph does not itself
enforce host-side tool dispatch.

The runner-level `runx.scopes` publishes the package's non-empty required-scope
metadata. Runtime authority remains narrowed at the executable graph steps,
where `scopes` and `allowed_tools` are declared again for the work performed by
each step.

Admission rejects UNC and device namespaces. Its path containment check is
lexical by design, so the consuming host has a mandatory physical-path
preflight before execution: resolve canonical paths, confirm `repo_root` is a
local normal Git checkout, confirm canonical `.worktrees` remains inside that
canonical repository, and reject any symlink or junction in the worktree root,
target, or their path components.

## Refusal conditions

Refuse before approval when any of these is true:

- the resolved digest is missing, malformed, or differs from the pin;
- a path is relative, escapes its parent, is not a direct child, or does not
  use the exact `.worktrees` root;
- a path uses a UNC or device namespace;
- the branch is unscoped, contains traversal/reflog syntax, or ends in `.lock`;
- the start commit is not an immutable full object id;
- the requested mechanism is not the fixed Git fallback;
- `max_worktrees` is not exactly one.

Digest drift raises `runx.overlay.digest.stale`. Boundary failures use a
specific `runx.overlay.attenuation.*` diagnostic. A refused admission never
reaches the approval or ticket step.

## Operator procedure

1. Resolve the immutable wrapped source through a trusted resolver, recompute
   its sha256, and retain public digest evidence.
2. Provide the bounded inputs above and run this package.
3. Review the normalized plan shown by the approval gate.
4. Approve only when the repository, worktree path, branch, start commit, and
   exact argv are correct.
5. Inspect the sealed graph receipt and the emitted single-effect authorization.
6. If a host consumes it, first complete the canonical local-path and
   symlink/junction preflight, atomically register the idempotency key, verify
   the effect with `git worktree list --porcelain`, and retain that effect
   receipt alongside this decision receipt.

## What the receipt proves

The receipt proves which immutable instructions were admitted, which authority
was requested and narrowed, which exact command was proposed, whether the
operator approved that exact plan, and which single-effect authorization was
issued. It does not prove host-side idempotency consumption or that a worktree
exists; execution and readback require a separate effect receipt.
