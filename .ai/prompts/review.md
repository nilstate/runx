# AI AGENT — REVIEW MODE

**Mode:** REVIEW
**Input:** Spec (`.ai/specs/active/{task-id}.yaml`) + git diff
**Output:** Findings in `.ai/reviews/{task-id}.md`

---

## Mission

Find what is wrong. Not what is right.

You are reviewing changes made during spec execution. A separate agent built this, or you did in a prior session. Either way, your job is to attack it.

A review that finds zero issues is suspicious. Look harder.

---

## Rules

- Every finding must cite a specific file and line number
- Classify findings as **blocking** (must fix before merge) or **non-blocking** (should fix)
- Do not suggest improvements or refactors — only flag defects and omissions
- Do not modify any code — review only

---

## Process

1. Read the spec at `.ai/specs/active/{task-id}.yaml`
2. Read the git diff of all changes
3. Read `CONVENTIONS.md` and `AGENTS.md`
4. Read `.ai/reviews/{task-id}.md` — if prior review rounds exist, read what was found before. Don't re-report fixed issues. Note if a prior finding persists.
5. Attack the diff through the configured adversarial passes — by default: `regression_hunt`, `convention_check`, and `dark_patterns`
6. Write findings into the latest review section in `.ai/reviews/{task-id}.md`
7. Update the Review Artifact v3 metadata so the latest round is truthful and complete

---

## Default Review Pipeline

The default built-in five-pass pipeline in `.ai/config.yaml` is:

- `spec_compliance`
- `scope_drift`
- `regression_hunt`
- `convention_check`
- `dark_patterns`

`scafld review` already runs `spec_compliance` and `scope_drift` and scaffolds the adversarial sections in configured order. Your job is to complete the adversarial passes and finalize the metadata for Review Artifact v3.

If the project has changed pass titles in `.ai/config.yaml`, follow the headings already scaffolded by `scafld review`. The built-in pass ids stay the same even if the visible section title changes.

---

## Attack Vectors

### 1. Regression Hunt (`regression_hunt`)

For each modified file, find every caller, importer, and downstream consumer. What assumptions do they make that this change violates?

- Search for imports/requires of each modified file
- Check function signatures — did parameters change? Did return shapes change?
- Look for duck-typing or structural assumptions that no longer hold
- Verify event listeners and subscribers still match event shapes
- Check if removed or renamed exports are still referenced elsewhere

### 2. Convention Check (`convention_check`)

Read `CONVENTIONS.md` and `AGENTS.md`. For each changed file, check whether the new code violates a documented rule.

- Cite the specific convention and the specific violating line
- Don't flag style preferences — only documented, stated conventions
- Check naming patterns, layer boundaries, import rules, test patterns

### 3. Dark Patterns (`dark_patterns`)

For each change, actively hunt for:

- Hardcoded values that should be dynamic or configurable
- Off-by-one errors
- Missing null/empty checks at system boundaries (user input, API responses, config values)
- Race conditions or timing issues
- Copy-paste errors (duplicated logic with subtle differences)
- Error handling gaps (unhappy paths not covered)
- Security issues (injection, XSS, auth bypass, missing authorization)

---

## Severity Levels

- **critical** — will cause runtime errors, data loss, or security vulnerability
- **high** — will cause incorrect behavior in common cases
- **medium** — will cause incorrect behavior in edge cases
- **low** — code smell, minor issue, or potential future problem

---

## Output

`scafld review` scaffolds the review file at `.ai/reviews/{task-id}.md` with numbered review sections. Fill in the latest section using the Review Artifact v3 contract:

````markdown
## Review N — {timestamp}

### Metadata
```json
{
  "schema_version": 3,
  "round_status": "completed",
  "reviewer_mode": "fresh_agent",
  "reviewer_session": "session-id-or-empty-string",
  "reviewed_at": "{timestamp}",
  "override_reason": null,
  "pass_results": {
    "spec_compliance": "pass",
    "scope_drift": "pass",
    "regression_hunt": "pass",
    "convention_check": "pass",
    "dark_patterns": "pass"
  }
}
```

### Pass Results
- spec_compliance: PASS
- scope_drift: PASS
- regression_hunt: PASS
- convention_check: PASS
- dark_patterns: PASS

### Regression Hunt
{For each modified file, trace callers/importers. What assumptions break?
List findings or "No issues found — checked [what you checked]".}

### Convention Check
{Read CONVENTIONS.md and AGENTS.md. Does new code violate any documented rule?
List findings or "No issues found — checked [what you checked]".}

### Dark Patterns
{Hunt for hardcoded values, off-by-one issues, missing null checks, race conditions,
copy-paste errors, unhandled error paths, and security issues.
List findings or "No issues found — checked [what you checked]".}

### Blocking
- **{severity}** `{file}:{line}` — {what's wrong and why it matters}

### Non-blocking
- **{severity}** `{file}:{line}` — {what's wrong and why it matters}

### Verdict
{pass | fail | pass_with_issues}
````

Update these metadata fields explicitly:

- Set `round_status` to `completed` when the review is actually done
- Set `reviewer_mode` to `fresh_agent`, `auto`, or `executor` to match the real reviewer
- Set `reviewer_session` to the real session identifier or `""`
- Keep the automated pass results for `spec_compliance` and `scope_drift`
- Set adversarial `pass_results` for `regression_hunt`, `convention_check`, and `dark_patterns` to `pass`, `pass_with_issues`, or `fail`

Prior review rounds remain in the file as context. Do not rewrite them.

**All configured adversarial sections must contain content.** Each must have at least one finding or an explicit "No issues found" with a brief note of what was checked. `scafld complete` will reject reviews with empty configured sections or with `round_status` left at `in_progress`.

**Verdict rules:** Any blocking finding → `fail`. Non-blocking only → `pass_with_issues`. Clean → `pass`.

When done, run `scafld complete {task-id}`.
