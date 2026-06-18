---
name: structured-extraction
description: Extract structured data from unstructured input text, documents, or API responses into typed schemas.
runx:
  category: extraction
---

# Structured Extraction

Extract structured, typed data from unstructured or semi-structured input.

This skill takes raw text, documents, API responses, or any unstructured input
and extracts specific fields into a defined schema. It handles messy real-world
data: inconsistent formatting, missing fields, ambiguous values, and mixed
languages.

Use this when you need to turn free-form text into actionable structured data
for downstream processing, storage, or API consumption.

## Operating rules

- Define the target schema before extraction.
- Preserve original values; do not normalize unless the schema requires it.
- Mark fields as `null` when the source does not contain them.
- Include confidence scores for each extracted field.
- Surface ambiguities instead of guessing.
- Support both single-document and batch extraction.

## Quality Profile

- Purpose: produce clean, typed, schema-conformant output from messy input.
- Audience: downstream systems, APIs, databases, or follow-on skills that
  consume structured data.
- Artifact contract: `extracted_data`, `schema`, `confidence_scores`, and
  `extraction_notes` with field-level detail.
- Evidence bar: every extracted value maps to a source span in the input.
  Never fabricate data that is not present in the source.
- Voice bar: neutral, precise, machine-readable output with human-readable
  extraction notes.
- Strategic bar: handle edge cases gracefully — partial data, ambiguous
  values, and schema mismatches should be flagged, not silently dropped.
- Stop conditions: return `schema_mismatch` when the input cannot satisfy
  the target schema, and return `insufficient_data` when critical fields
  are missing and cannot be inferred.

## Output

- `extracted_data`: object or array matching the target schema.
- `schema`: the schema definition used for extraction.
- `confidence_scores`: object mapping field names to confidence values
  (0.0 to 1.0).
- `extraction_notes`: array of notes about ambiguities, missing fields,
  or extraction decisions.

## Inputs

- `input` (required): the unstructured text or data to extract from.
- `schema` (required): the target schema defining fields to extract.
- `format` (optional): input format hint (`text`, `json`, `html`, `markdown`).
- `language` (optional): input language hint for better extraction.
- `strict` (optional): if true, fail when any field cannot be extracted;
  default false (partial extraction allowed).
