---
name: markdown-toc
description: Generate a table of contents from markdown content
runx.category: utility
---

# markdown-toc

## What this skill does

Extracts headings from markdown text and outputs a structured table of contents as JSON. Preserves heading hierarchy (h1 → h2 → h3 → h4) and handles edge cases like duplicate headings by appending numeric suffixes.

## Procedure

1. Read markdown content from stdin or the `content` input
2. Parse lines starting with `# `, `## `, `### `, `#### `, `##### ` to extract heading level and text
3. Build a nested tree preserving document order
4. Output structured JSON with each heading's level, text, and anchor

## Worked example

Input:

```
# Introduction

## Getting Started

### Installation

## Configuration

# API Reference

## Endpoints
```

Command:

```bash
echo "# Introduction\n\n## Getting Started\n\n### Installation\n\n## Configuration\n\n# API Reference\n\n## Endpoints" | markdown-toc
```

Output:

```json
[
  {"level": 1, "text": "Introduction", "anchor": "introduction"},
  {"level": 2, "text": "Getting Started", "anchor": "getting-started"},
  {"level": 3, "text": "Installation", "anchor": "installation"},
  {"level": 2, "text": "Configuration", "anchor": "configuration"},
  {"level": 1, "text": "API Reference", "anchor": "api-reference"},
  {"level": 2, "text": "Endpoints", "anchor": "endpoints"}
]
```

## Quality Profile

| Dimension | Assessment |
|-----------|------------|
| Correctness | Functions as a pure text parser — output matches markdown heading structure |
| Observability | Returns structured JSON with clear level/text/anchor fields |
| Safety | Read-only, no network or filesystem access needed |
| Determinism | Same input always produces same output |
| Robustness | Handles empty content, missing headings, duplicate anchors gracefully |

## CLI Runner

The skill includes a `run.mjs` Node.js CLI tool. Invoke it via the `default` runner:

```bash
RUNX_INPUTS_JSON='{"content":"# Hello\n\n## World"}' node run.mjs
```

Output:

```json
[
  { "level": 1, "text": "Hello", "anchor": "hello" },
  { "level": 2, "text": "World", "anchor": "world" }
]
```
