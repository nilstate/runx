---
name: sandbox-harden
description: Produce a least-privilege runtime hardening profile (seccomp, dropped capabilities, egress allowlist, filesystem posture) for a named workload, with the residual risk stated.
runx:
  category: security
---

# Sandbox Harden

Decide the narrowest sandbox a workload can run inside without breaking it.

## What this skill does

Most workloads ship with the default sandbox their runtime hands them: the full
seccomp default, a broad capability set, unrestricted egress, a writable root.
That default is sized for the worst case, not for this workload. This skill reads
what a named workload actually needs and emits the tightest posture that still
lets it run: an allowed-syscall list, the capabilities to drop, an egress
allowlist, and a filesystem stance, with the residual risk named in plain terms.

The output is a posture recommendation, not an enforced change. A runtime, an
orchestrator, or an operator applies it. This skill never executes the workload
and never widens a posture below the supplied baseline without saying why.

How it differs from its neighbors: `least-privilege` audits API scopes,
not syscalls; `audit-receipt` reads a sealed run after the fact. This skill is
the only one that reasons about the seccomp, capability, egress, and filesystem
posture a workload should run inside before it starts. The recommendation reads
input only and writes nothing; applying it is a separate runtime act that
exercises `sandbox:configure` on the named workload and nothing wider.

## When to use this skill

- Before running an untrusted or third-party workload, to decide its sandbox.
- During a security review of an existing deployment whose sandbox is the broad
  default.
- When promoting a workload toward production and the runtime posture must be
  reviewable, not implicit.
- When an operator needs the egress allowlist and dropped capabilities written
  down before a runtime applies them.

## When not to use this skill

- To run, build, or schedule the workload. This skill recommends a posture; a
  runtime, orchestrator, or operator executes the workload under it.
- To audit which API scopes or grants a subject used. That is
  `least-privilege`; it reasons about authority, this one reasons about
  syscalls, capabilities, egress, and the filesystem.
- To audit a sealed receipt for over-reach after the fact. That is
  `audit-receipt`.
- To handle, store, or surface the secret material a workload reads. A hardening
  profile names a mount path or a secret handle, never a secret value.
- To produce a posture for a workload whose identity is unknown. Return
  `needs_agent` instead of hardening an unnamed target.

## Procedure

1. **Resolve the workload.**
   - Accept an image digest (`sha256:...`) or a skill ref. Record which form was
     supplied as `hardening_profile.workload`.
   - Gate: if no workload is supplied, stop with `needs_agent`. There is nothing
     to harden.

2. **Build the behavior model.**
   - Combine the workload class (web service, batch job, CLI, language runtime),
     the supplied `threat_context`, and the `baseline` posture.
   - Distinguish known behavior from assumed behavior. A profile built on assumed
     syscall need is weaker evidence than one built on an observed or documented
     call set.
   - Gate: if the behavior is unknown enough that the syscall set, egress, or
     write paths would be a guess, stop with `needs_more_evidence` and name what
     observation would resolve it (a trace, a manifest, a dry run under audit
     seccomp).

3. **Recommend the seccomp profile.**
   - Default to `deny`. Add only syscalls the behavior model supports.
   - Prefer a named runtime default profile plus an explicit allow delta over a
     hand-rolled full list when the workload class has a known good baseline.
   - Never add a syscall family with no behavioral basis. Unknown need is a stop
     condition, not a blanket allow.

4. **Drop capabilities.**
   - Start from "drop all", then justify each capability kept.
   - A capability is kept only when the behavior model needs it. Name the reason
     per kept capability in the rationale.

5. **Set the egress posture.**
   - Default to `mode: none`. Move to `mode: allowlist` only when the workload
     has a named, justified destination set.
   - List hosts, not raw allow-everything. An empty allowlist means no egress.
   - Never recommend open egress as a convenience.

6. **Set the filesystem posture.**
   - Default to `readonly: true` with an explicit `writable_paths` list.
   - Each writable path is justified by the behavior model (scratch, cache, a
     declared output dir). A writable root is a finding, not a default.

7. **State residual risk.**
   - After the controls above, name what an attacker who fully controls the
     workload could still do, the `level`, and the `reason`.
   - Residual risk is never "none". If the profile is built on assumed behavior,
     say so here.

8. **Honor the baseline.**
   - The recommended posture must be at least as strict as the supplied baseline
     on every axis. If the model would relax any control below the baseline, do
     not relax it silently; either keep the baseline or, where a relaxation is
     genuinely warranted, record the reason in the rationale and raise the
     residual-risk level.

The narrowness gate and the evidence gate are the two that hold authority: no
control weaker than the baseline without a stated reason and a raised
residual-risk level, and no syscall, host, or write path with no behavioral
basis. A posture no tighter than the baseline with no new evidence is not worth
emitting.

## Edge cases and stop conditions

- **Missing workload:** return `needs_agent`; an unnamed target cannot be
  hardened.
- **Unknown behavior:** return `needs_more_evidence` with the observation that
  would resolve it; do not pad the syscall set with plausible families.
- **Workload needs a privileged capability** (for example `CAP_SYS_ADMIN`): keep
  it only with a stated reason and raise the residual-risk level; never drop a
  capability the workload provably needs just to look tighter.
- **Egress to a dynamic or unbounded host set:** keep `mode: allowlist` with the
  known hosts and flag the unbounded remainder as residual risk; do not fall back
  to open egress.
- **Baseline is already tighter than the model:** keep the baseline; the
  recommendation never loosens a control the operator already set.
- **Secret material in the input:** reference it by mount path or handle in the
  profile and rationale; never copy a secret value into the output.
- **Conflicting threat context and baseline:** prefer the stricter control and
  name the conflict in the rationale.

## Output schema

```yaml
hardening_profile:
  decision: ready | needs_more_evidence | needs_agent
  workload:
    ref_form: image_digest | skill_ref
    image_digest: string
    skill_ref: string
    class: string
  seccomp:
    default: deny | allow
    allowed_syscalls: array
  dropped_caps: array
  egress:
    mode: none | allowlist
    hosts: array
  filesystem:
    readonly: boolean
    writable_paths: array
  residual_risk:
    level: low | medium | high
    reason: string
  rationale: string
```

The single `hardening_profile` object is packet `runx.hardening.v1`. Secrets,
tokens, key material, and raw fetched content never appear in the profile;
secret-bearing inputs are referenced by mount path or handle only. The receipt
carries the workload ref form and digest, the four posture axes, the
residual-risk level, the stop status, and the quality and voice profile hashes.
It carries no secret values and no syscall trace payloads.

## Worked example

Input: `workload` is `{ image_digest: "sha256:1f4c...", class: "batch job" }`;
`threat_context` is "processes untrusted user uploads, no inbound network";
`baseline` is "docker default seccomp, all caps, open egress, writable root".

Output: `decision: ready`. `seccomp.default: deny` with an allowed set covering
file I/O, memory, and process control but not `ptrace`, `mount`, or raw socket
families. `dropped_caps` is the full default set (the job needs none).
`egress.mode: none` (no inbound or outbound network in the threat context).
`filesystem.readonly: true` with `writable_paths: ["/tmp/work"]` for upload
scratch. `residual_risk.level: low`, reason: a compromised job can still consume
CPU and fill `/tmp/work` to its quota; it cannot reach the network or escalate.
The rationale records that the syscall set is assumed from the batch-job class,
not from an observed trace, so a trace would raise confidence without widening
the posture.

## Inputs

- `workload` (required, json): the target to harden, as `{ image_digest }` or
  `{ skill_ref }`, optionally with `class`. Without it the skill returns
  `needs_agent`.
- `threat_context` (optional, string): the trust assumptions and exposure, for
  example "processes untrusted uploads, no inbound network".
- `baseline` (optional, string): the current or floor posture. The
  recommendation is never weaker than this without a stated reason.
