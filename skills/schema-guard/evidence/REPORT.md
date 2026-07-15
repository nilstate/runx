# Schema Guard Delivery Report

- Published qq2401672073-hub/schema-guard@sha-e43e5c41e370 at the public runx registry with package digest bc052345fb138abcdddee122be7be7e4d9821a00d30f9c6a553e007eb86a2433.
- The graph reads the current schema only from the caller's explicit HTTP(S) allowlist and seals the final URL, status, SHA-256 content digest, redirects, byte count, and truncation state.
- The evaluator supports a documented deterministic JSON Schema/OpenAPI component subset, validates nested contracts and representative payloads, and fails closed on malformed or unsupported input.
- Additive changes such as an optional property are accepted; deletions, required-field additions, optional-to-required changes, type changes, enum narrowing, stricter formats, and unsupported constraints are reported with precise JSON Pointer evidence.
- Compatible execution consumes the evaluator's event in a bounded append-only registry transport, enforces expected version plus idempotency, then reads the identical aggregate back before projecting a published result.
- Breaking execution is sealed as policy_denied after fetch and evaluation; append, readback, and result projection are absent. An unreachable source also fails before any registry effect.
- Fresh unit verification passed 36/36 tests. Fresh package harness verification passed all 5 discovered cases with zero assertion errors.
- The hosted runx registry harness passed both declared hosted cases, produced two receipt IDs, and reports zero failed checks.
- A post-publication dogfood run used the exact registry package, fetched the immutable GitHub schema, committed version 1, read it back, and projected matching source, verdict, event, and stored-event digests.
- The dogfood root receipt is runx:receipt:sha256:af38d75f55e7d47caf4e373dfcb880bafb0d25a86c2462ecef66de161e5ecd57; runx verify returned valid: true, production signature mode, valid digest, valid content address, and valid Ed25519 signature.
- Clean registry read and clean install both succeeded for the exact published version; the package is self-contained and does not depend on operator-local tools or sibling registry skills.
- Secrets, tokens, signer seed material, headers, cookies, provider evidence, and unrestricted response bodies are excluded from the public terminal projection and committed evidence.
