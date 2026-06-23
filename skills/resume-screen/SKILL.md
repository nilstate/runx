# Resume Screen

`resume-screen` applies only a supplied, job-related rubric to bounded resume
evidence. It scores and ranks candidates, flags missing evidence and bias risks,
drafts evidence-grounded interview questions, and proposes a shortlist for
human approval.

It never hires, rejects, contacts, or advances a candidate.

## Inputs

- `resumes[]`: candidate IDs and job-related evidence items.
- `jd`: role title and requirements.
- `rubric`: weighted criteria, minimum experience, and shortlist size.

Evidence items should include `skill`, `years`, and `source`. Do not pass names,
photos, age, race, ethnicity, sex, gender identity, religion, disability,
pregnancy, marital status, citizenship, national origin, or other protected
attributes.

## Outputs

- `scored[]`: criterion-level scores and evidence citations.
- `ranked[]`: deterministic order by score and candidate ID.
- `red_flags[]`: missing evidence and detected protected-attribute inputs.
- `interview_qs[]`: questions tied to rubric evidence gaps.
- `shortlist_proposal`: a proposal requiring a human approval lane.

## Guardrails

- Score only criteria supplied in the rubric.
- Ignore and flag protected attributes instead of using them.
- Do not infer protected attributes from names, schools, locations, or dates.
- Refuse requests to make a final hire, reject, or advance decision.
- Emit no hiring action or external effect.
- Preserve candidate IDs rather than exposing unnecessary personal data.

This is a structured screening aid. A human reviewer remains responsible for
fairness, legal compliance, accommodations, interviews, and every employment
decision.

