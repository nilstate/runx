---
name: joke-generator
description: Fetch a random joke using a public API.
runx:
  category: context
---

# Joke Generator

This skill fetches a random joke from the official joke API.

## Edge cases and governance

- **Timeouts**: The API may be slow. A timeout will cause a `failure`.
- **Receipts**: The sealed receipt must be preserved for provenance.
- **Failures**: If the rate limit is exceeded, return `needs_input`.
