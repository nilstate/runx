---
name: structured-extraction
description: Extract schema-validated JSON from messy HTML or text fixtures with digest-bound provenance.
source:
  type: cli-tool
  command: node
  args:
    - tools/structured/extract/run.mjs
runx:
  tags:
    - extraction
    - schema-validation
    - provenance
---

# Structured Extraction

Use this skill to turn messy HTML or text into schema-validated JSON with
reproducible input and output digests.

The default harness extracts a compact API-reference summary from the RFC 9110
HTML document. It records the source URL, fixture byte count, input digest,
schema digest, extracted items, validation status, and artifact ids that the
runx receipt can bind as references.

Inputs:

- `input_path`: package-relative path to an HTML or text fixture.
- `schema_path`: package-relative JSON Schema path.
- `source_url`: canonical public source URL for the fixture.
- `content_type`: `text/html` or `text/plain`.
- `max_items`: maximum extracted items to include.

The output packet is `runx.structured_extraction.result.v1`.
