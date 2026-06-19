# Structured Extraction Skill

This skill extracts schema-validated JSON from messy HTML or text fixtures. The
default harness uses the real RFC 9110 HTML document as a deterministic input.

It emits `runx.structured_extraction.result.v1` and includes artifact
references for:

- input fixture SHA-256
- JSON Schema SHA-256
- validated output payload SHA-256

Reproduce:

```powershell
runx harness . --receipt-dir .\receipts --json
```

The Frantic #22 delivery evidence was generated from
`fixtures/rfc9110-http-semantics.html` with source URL
`https://www.rfc-editor.org/rfc/rfc9110.html`.
