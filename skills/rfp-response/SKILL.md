---
name: rfp-response
description: Draft cited RFP and security-questionnaire answers from a supplied knowledge pack, with gaps for unsupported questions.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  input_mode: stdin
  cwd: .
  timeout_seconds: 30
inputs:
  questionnaire:
    type: json
    required: true
    description: Array of questionnaire prompts with id, question text, and optional section.
  knowledge_pack:
    type: json
    required: true
    description: Sources and claims that may be cited in answers.
  objective:
    type: string
    required: false
    description: Optional operator intent for the draft.
runx:
  category: business-ops
  input_resolution:
    required:
      - questionnaire
      - knowledge_pack
---

# rfp-response

Use this skill when an operator needs a reviewable RFP or security-questionnaire
draft that is grounded only in supplied company knowledge. The skill reads a
questionnaire and knowledge pack, drafts cited answers for supported questions,
and records unsupported questions as gaps instead of inventing certifications,
controls, metrics, or contractual claims.

The skill is read-only over its inputs. It performs no network calls, sends no
responses, stores no secrets, and emits only a draft for human approval before it
leaves the organization.

## Inputs

- `questionnaire`: array of `{id, question, section}` records.
- `knowledge_pack`: object with a `sources` array. Each source may contain
  `id`, `title`, `url`, and `claims`; each claim may contain `id`, `text`, and
  optional `tags`.
- `objective`: optional operator intent.

## Output

The runner returns JSON with:

- `answers` array: `{q, answer, citations, confidence}` for grounded answers.
- `gaps` array: unsupported questions with missing-evidence notes.
- `evidence_json` object: compact verification summary.
- `report` string: human-readable draft review notes.

Every answer contains at least one citation. Questions without supporting
knowledge are placed in `gaps` and are not answered.
