---
name: sandbox-harden
description: Produce a least-privilege runtime hardening profile (seccomp, dropped capabilities, egress allowlist, filesystem posture) for a named workload, with the residual risk stated.
runx:
  category: security
---

# Sandbox Harden

Decide the narrowest sandbox a workload can run inside without breaking it.

Most workloads ship with the default sandbox their runtime hands them: the full
seccomp default, a broad capability set, unrestricted egress, a writable root.
That default is sized for the worst case, not for this workload. This skill
reads what a named workload actually needs and emits the tightest posture that
still lets it run: an allowed-syscall list, the capabilities to drop, an egress
allowlist, and a filesystem stance, with the residual risk named in plain terms.

The output is a posture recommendation, not an enforced change. A runtime, an
orchestrator, or an operator applies it. This skill never executes the workload
and never widens a posture below the supplied baseline without saying why.

It emits the posture a workload should run under; `container-run` executes a
workload, and `least-privilege-auditor` audits scopes, not syscalls.

## What this skill does

1. Resolve the workload from an image digest or a skill ref.
2. Build a behavior model from threat context, baseline posture, and known
   workload class. Name what is unknown.
3. Recommend the narrowest seccomp profile, capability drop set, egress
   allowlist, and filesystem posture that still runs the workload.
4. State the residual risk after hardening: level and the reason it remains.
5. Refuse to relax any control below the baseline without a stated reason.

## When to use this skill

- Before running an untrusted or third-party workload, to decide its sandbox.
- During a security review of an existing deployment whose sandbox is the broad
  default.
- When promoting a workload toward production and the runtime posture must be
  reviewable, not implicit.
- When an operator needs the egress allowlist and dropped capabilities written
  down before a runtime applies them.

## When not to use this skill

- To run, build, or schedule the workload. That is `container-run`.
- To audit which API scopes or grants a subject used. That is
  `least-privilege-auditor`; it reasons about authority, this one reasons about
  syscalls, capabilities, egress, and the filesystem.
- To audit a sealed receipt for over-reach after the fact. That is
  `receipt-auditor`.
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
   - Distinguish known behavior from assumed behavior. A profile built on
     assumed syscall need is weaker evidence than one built on an observed or
     documented call set.
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
   - The recommended posture must be at least as strict as the supplied
     baseline on every axis. If the model would relax any control below the
     baseline, do not relax it silently; either keep the baseline or, where a
     relaxation is genuinely warranted, record the reason in the rationale and
     raise the residual-risk level.

## Edge cases and stop conditions

- **Missing workload:** return `needs_agent`; an unnamed target cannot be
  hardened.
- **Unknown behavior:** return `needs_more_evidence` with the observation that
  would resolve it; do not pad the syscall set with plausible families.
- **Workload needs a privileged capability** (for example `CAP_SYS_ADMIN`):
  keep it only with a stated reason and raise the residual-risk level; never
  drop a capability the workload provably needs just to look tighter.
- **Egress to a dynamic or unbounded host set:** keep `mode: allowlist` with the
  known hosts and flag the unbounded remainder as residual risk; do not fall
  back to open egress.
- **Baseline is already tighter than the model:** keep the baseline; the
  recommendation never loosens a control the operator already set.
- **Secret material in the input:** reference it by mount path or handle in the
  profile and rationale; never copy a secret value into the output.
- **Conflicting threat context and baseline:** prefer the stricter control and
  name the conflict in the rationale.

## Output

A single `hardening_profile` object (`runx.hardening.v1`):

- `hardening_profile.workload`: object naming the target. Carries the supplied
  ref form (`image_digest` or `skill_ref`) and `class`. Never a secret.
- `seccomp`: object with `default` (`deny` recommended) and `allowed_syscalls`
  (array of syscall names or families with a behavioral basis).
- `dropped_caps`: array of Linux capabilities to drop (often the full default
  set minus a named kept few).
- `egress`: object with `mode` (`none` | `allowlist`) and `hosts` (array; empty
  when `mode: none`).
- `filesystem`: object with `readonly` (boolean) and `writable_paths` (array of
  justified paths; empty when fully read-only).
- `residual_risk`: object with `level` (`low` | `medium` | `high`) and `reason`
  (what an attacker controlling the workload could still do).
- `rationale`: string. Why each kept capability, allowed host, and writable
  path is justified, and where the model rests on assumed rather than observed
  behavior.
- `decision`: `ready` | `needs_more_evidence` | `needs_agent`.

Secrets, tokens, key material, and raw fetched content never appear in the
profile. Secret-bearing inputs are referenced by mount path or handle only.

## Governance

- **Scopes the recommended posture implies:** the profile is advisory; applying
  it is a separate runtime act. The recommendation itself reads input only and
  writes nothing. A runtime that applies it would exercise `sandbox:configure`
  on the named workload and nothing wider.
- **Gates:** the narrowness gate (no control weaker than the baseline without a
  stated reason and a raised residual-risk level) and the evidence gate (no
  syscall, host, or write path with no behavioral basis).
- **Receipt:** carries the workload ref form and digest, the four posture axes,
  the residual-risk level, the stop status, and the quality-profile and
  voice-profile hashes. It carries no secret values, no raw fetched content, and
  no syscall trace payloads, only the recommended posture and its references.

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
not from an observed trace, so a trace would raise confidence.

## Quality Profile

- Purpose: emit the narrowest seccomp, capability, egress, and filesystem
  posture a named workload can run under, with residual risk stated, so a
  runtime or operator can apply a reviewed sandbox instead of the broad default.
- Audience: the security reviewer, operator, or runtime that will apply or
  reject the posture before the workload runs.
- Artifact contract: `hardening_profile` (`runx.hardening.v1`) with `workload`,
  `seccomp.default` and `seccomp.allowed_syscalls`, `dropped_caps`,
  `egress.mode` and `egress.hosts`, `filesystem.readonly` and
  `filesystem.writable_paths`, `residual_risk.level` and `residual_risk.reason`,
  and `rationale`. No secret values, no raw fetched content.
- Evidence bar: every allowed syscall, kept capability, allowed host, and
  writable path names its behavioral basis. Assumed behavior is labeled as
  assumed and lowers confidence; it never silently widens the posture. Residual
  risk is never recorded as "none".
- Voice bar: terse reviewer-to-operator prose. Posture fields are interface and
  stay factual; the rationale explains the why, not the obvious. No generic
  security adjectives, no AI framing.
- Strategic bar: the profile must make a concrete apply-or-reject decision
  easier and shrink the workload's blast radius from the default. A posture no
  tighter than the baseline with no new evidence is not worth emitting.
- Stop conditions: return `needs_agent` when the workload is missing, and
  `needs_more_evidence` when the workload behavior is unknown enough that the
  syscall set, egress, or write paths would be a guess. Prefer a precise stop
  over a plausible but unsupported posture.

## Inputs

- `workload` (required, json): the target to harden, as `{ image_digest }` or
  `{ skill_ref }`, optionally with `class`. Without it the skill returns
  `needs_agent`.
- `threat_context` (optional, string): the trust assumptions and exposure, for
  example "processes untrusted uploads, no inbound network".
- `baseline` (optional, string): the current or floor posture. The
  recommendation is never weaker than this without a stated reason.
