---
name: answer-from-docs
description: Answer a question strictly from a bounded corpus and refuse unsupported questions with explicit knowledge-base gaps.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 10
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  question:
    type: string
    required: true
    description: Question to answer from the provided corpus only.
  corpus:
    type: json
    required: true
    description: Array of bounded corpus items. Each item may be a string or an object with id, title, text, or content.
runx:
  input_resolution:
    required:
      - question
      - corpus
  artifacts:
    wrap_as: answer_from_docs_packet
---

# Answer From Docs

Answer From Docs turns a bounded `corpus[]` fixture into a grounded answer packet.
It performs no retrieval, network access, mutation, or hidden knowledge lookup. It
only uses the corpus supplied in the input.

## Behavior

1. Normalize the question and each corpus item.
2. Split corpus text into sentence-sized evidence candidates.
3. Score candidates by overlap with meaningful question terms.
4. Return a concise answer only when the selected evidence clears the grounding
   threshold.
5. Attach citations to every answer sentence using the source corpus item id.
6. Refuse uncovered questions by returning `grounded: false` and explicit
   `kb_gaps`.

## Inputs

- `question` (required): a non-empty question.
- `corpus` (required): an array of strings or objects. Object items can provide
  `id`, `title`, `text`, `content`, `body`, or `markdown`.

## Output

```yaml
answer:
  text: string
  citations:
    - sentence: string
      source_id: string
      source_title: string | null
      evidence: string
kb_gaps:
  - string
grounded: boolean
```

## Refusal Rules

- Refuse when `corpus[]` is empty or has no readable text.
- Refuse when the best evidence does not overlap enough meaningful question
  terms.
- Refuse instead of answering from general model knowledge.
- Refuse rather than inventing citations.

## Verification Notes

A valid harness includes one grounded case and one refused case. The grounded
case must return at least one citation, and the refused case must set
`grounded: false` with a non-empty `kb_gaps[]`.
