---
name: answer-from-docs
description: Answer a question strictly from a bounded corpus, returning citations for grounded answers and refusing unsupported questions with knowledge-base gaps.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 15
inputs:
  question:
    type: string
    required: true
    description: The user question to answer from the supplied corpus.
  corpus:
    type: json
    required: true
    description: Bounded documentation corpus array with id, title, and text fields.
runx:
  category: ops
  input_resolution:
    required:
      - question
      - corpus
  artifacts:
    named_emits:
      grounded_answer: runx.grounded_answer.v1
---

# Answer From Docs

`answer-from-docs` answers one question from a bounded documentation corpus. It
does not fetch live docs, search the web, call a retrieval system, mutate state,
or infer product behavior outside the supplied corpus.

## Use This Skill When

- A team needs a checkable answer from a small, supplied knowledge base.
- A workflow needs citation-backed answers that can be audited from the run
  input alone.
- Unsupported questions should be refused instead of answered from general
  knowledge.

## Do Not Use This Skill For

- Live retrieval, external documentation search, or connector-backed Q&A.
- Answering from private state not present in `corpus`.
- Guessing missing limits, pricing, security posture, roadmap, or policy.

## Inputs

- `question`: the question to answer.
- `corpus`: an array of documentation items. Each item should include `id`,
  `title`, and `text`.

## Outputs

- `answer`: object with `text` and `citations`.
- `kb_gaps`: missing evidence needed to answer unsupported questions.
- `grounded`: boolean verdict.

## Procedure

1. Validate that `question` is non-empty and `corpus` contains at least one
   readable item.
2. Split each corpus item into citeable sentences.
3. Score sentences by overlap with meaningful question terms.
4. Answer only when at least one sentence has enough overlap to support the
   question.
5. Attach citations to every answer sentence using the source corpus item id,
   title, and sentence index.
6. If the corpus does not support the question, emit `grounded: false`,
   an empty answer, and specific `kb_gaps`.

## Refusal Conditions

- `question` is empty or missing.
- `corpus` is missing, empty, or contains no readable text.
- No corpus sentence provides enough evidence for the question.

## Output Schema (`grounded_answer`)

```yaml
answer:
  text: string
  citations:
    - source_id: string
      title: string
      sentence_index: number
      quote: string
kb_gaps:
  - string
grounded: boolean
```
