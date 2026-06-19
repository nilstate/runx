---
name: markdown-toc
description: Generate a structured table of contents from markdown content by extracting headings
runx:
  category: utility
---

# markdown-toc

Extract a heading tree from markdown content and return it as structured JSON.
This is a non-connector utility skill — it transforms data without calling
external APIs, mutating state, or requiring network access.

## Quick Start

```bash
echo "# Hello\n\n## World\n\n### Foo" | markdown-toc
```

Output:

```json
{"toc": [{"level": 1, "text": "Hello", "anchor": "hello"}, {"level": 2, "text": "World", "anchor": "world"}, {"level": 3, "text": "Foo", "anchor": "foo"}]}
```

## Quality Profile

- **Purpose:** Produce a machine-readable heading index from arbitrary markdown
  so downstream skills can navigate, summarize, or restructure content by
  section.
- **Audience:** downstream skills or graphs that consume markdown and need a
  structural index — summarizers, rewriters, content-pipeline steps, or
  knowledge-router stages.
- **Artifact contract:** a JSON object with a `toc` array, each entry holding
  `level`, `text`, `anchor`, and child nesting hints.
- **Evidence bar:** the input markdown is the sole source of truth. Do not
  infer, guess, or complete headings that are not present in the input.
- **Voice bar:** output is JSON — no narrative, no commentary, no framing.
- **Strategic bar:** downstream callers use the TOC to decide which sections to
  process, skip, or reorder. Accuracy of hierarchy and anchors matters.
- **Stop conditions:** return `empty` when the input contains no headings.
  Return `needs_input` when the input is empty or not valid markdown.

## Core Features

- Extract all headings (h1 through h6) from markdown text
- Preserve heading hierarchy with nesting information
- Generate anchor slugs compatible with common markdown renderers
- Output as structured JSON

## When to use this skill

- A downstream skill needs to navigate markdown by section
- A content-pipeline step needs a structural index before rewriting or
  summarizing
- A knowledge-router needs a table of contents for chunked context

## When not to use this skill

- To render markdown to HTML or any visual format
- To modify the original markdown content
- When the markdown contains no headings — use a different indexing strategy

## Inputs

- `content` (required): the markdown text to analyze. Must be valid markdown
  text; at least one `#`-prefixed heading line yields a non-empty TOC.

## Outputs

- `toc`: array of heading entries, each with:
  - `level`: heading depth (1–6)
  - `text`: the heading text without the `#` prefix
  - `anchor`: a slug suitable for same-page anchor links
  - `children`: nested sub-headings, if any, recursively

## Edge cases

- **No headings:** return `toc: []` with a `note: "empty"` rather than failing.
- **Empty input:** return `needs_input` stop condition.
- **Code blocks containing `#`:** do not treat `#` inside fenced code blocks as
  headings.
- **Edge-case heading text:** leading/trailing whitespace in heading text is
  trimmed. HTML in heading text is left as-is in the `text` field.
- **Duplicate anchors:** append a numeric suffix (`-1`, `-2`) to disambiguate.
