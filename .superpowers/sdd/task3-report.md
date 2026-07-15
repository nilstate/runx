# Task 3 Report — Schema Guard Graph Composition

Date: 2026-07-15
Base revision: `224532774bdf6067757cac84d15656029e4327db`
Commit message: `feat(schema-guard): compose source read and registry effect`

## Scope

Implemented the `schema-guard` `0.1.0` default graph runner and its public
contract, three standalone fixtures, package-level inline harness cases, and a
self-contained dependency boundary under `skills/schema-guard/graph/`.
`core.mjs`, `run.mjs`, their tests, and
`fixtures/current-invoice.schema.json` were not modified.

The graph order is:

1. `fetch-current` — package-local canonical `graph/web-fetch`;
2. `evaluate` — deterministic `run.mjs`, with explicit proposed-schema,
   sample, policy, version, and idempotency inputs plus fetched evidence in
   context;
3. `append-version` — package-local canonical `graph/data-store`, guarded by
   `evaluate.compatibility.data.compatible == true` and consuming
   `evaluate.registry_event.data`;
4. `readback` — the same registry ref, store id, resource, and aggregate.

The compatible graph output exposes typed `compatibility: object`,
`validation_results: array`, `migration_notes: array`, and
`publish_result: object`. The readback step wraps its sealed result as
`publish_result`; the graph payload also retains the append and readback
`data_operation_result` packets.

## RED evidence

The three standalone fixtures were created before `X.yaml`, `SKILL.md`, or the
vendored graph dependencies.

Initial Windows command with `runx-cli 0.6.19`:

```text
runx harness ./skills/schema-guard --json
RED_EXIT_CODE=1
runx: native harness replay failed for ./skills/schema-guard:
failed to read harness fixture ./skills/schema-guard: 拒绝访问。 (os error 5)
```

The prescribed Linux Docker retry, still before the package contract existed,
failed as expected:

```text
runx-cli 0.6.19
runx harness ./skills/schema-guard --json
DOCKER_RED_EXIT_CODE=1
runx: native harness replay failed for ./skills/schema-guard:
failed to read harness fixture ./skills/schema-guard: Is a directory (os error 21)
```

After the package was added, published `@runxhq/cli@0.6.19` proved incompatible
with the current canonical `skills/web-fetch`: even that original package
reported `declared run output "fetch_result" was not returned by the step`.
Tracing the exact child process showed Node 22 failing inside the 0.6.19
4-GiB virtual-memory limit while instantiating Undici's WebAssembly parser.
Per operator direction, final harness evidence therefore uses the CLI built
from the current repository sources rather than treating that published-binary
failure as a vendoring defect.

## GREEN unit tests

Command:

```text
node --test skills/schema-guard/tests/*.test.mjs
```

Result:

```text
tests 34
pass 34
fail 0
duration_ms 1453.3681
exit code 0
```

## GREEN current-CLI harness

Environment:

- `rust:1.95-bookworm`;
- current repository CLI built from `crates/runx-cli`;
- `runx-cli 0.7.2`;
- Node `v22.23.1` inside the Linux container;
- Node launched with `--disable-wasm-trap-handler` to operate under the
  runtime's bounded virtual-memory policy;
- hosted Ed25519 test signer supplied through the three documented
  `RUNX_RECEIPT_SIGN_*` variables;
- receipts written to container-local `/tmp/task3-final-receipts`;
- local registry effects written to container-local `/tmp/runx-data-store`.

Command under the mounted repository:

```text
/target/debug/runx harness ./skills/schema-guard \
  -R /tmp/task3-final-receipts --json
```

Exact harness JSON:

```json
{
  "status": "passed",
  "case_count": 6,
  "assertion_error_count": 0,
  "assertion_errors": [],
  "case_names": [
    "additive-compatible-recorded",
    "breaking-change-refused",
    "unreachable-source-refused",
    "additive-compatible-recorded",
    "breaking-change-refused",
    "unreachable-source-refused"
  ],
  "receipt_ids": [
    "sha256:700a49d2d88eaddc783272a0d7475055f186102f49eb952e3415b3838d13b4f5",
    "sha256:1f5bf4ac33e181c34020d8404a706cf13d3708b61cfc960dd7321c178207f57b",
    "sha256:4572a197c43bc03f6b06a9a65f41dfb3e29d01c26b946c29fcc4d3fb5103a847",
    "sha256:c03a3941950453ce03734de1fa48ab43e5658c70b497267b7e6813f1c42d579e",
    "sha256:26f6923da81dd6aa000f2a9bc11f1f474627b1d608aeae3935328efa8f328710"
  ],
  "graph_case_count": 3
}
```

Current CLI discovers both the three inline compatibility cases and the three
standalone `fixtures/*.yaml` cases, hence `case_count: 6`. The inline compatible
and breaking cases execute the real composed graph. The inline unreachable
case exercises required-input fail-closed admission and emits no receipt or
effect. The standalone unreachable case carries the complete unreachable URL
input and seals the current fixture-replay failure envelope with exactly the
fetch/evaluate steps. This split is necessary because the conventional
standalone graph-fixture path treats a child process error as a harness
infrastructure error, while the package inline path is the production skill
front that seals the governed breaking guard correctly.

## Receipt and effect checks

The final evidence script parsed the receipt tree, independently reran the two
standalone refusal fixtures, inspected the local registry store, and failed on
any unexpected append/readback. It exited `0` with this exact summary:

```json
{
  "inline_compatible_receipt_id": "sha256:700a49d2d88eaddc783272a0d7475055f186102f49eb952e3415b3838d13b4f5",
  "inline_compatible_act_ids": [
    "act_fetch-current",
    "act_evaluate",
    "act_append-version",
    "act_readback"
  ],
  "inline_breaking_receipt_id": "sha256:1f5bf4ac33e181c34020d8404a706cf13d3708b61cfc960dd7321c178207f57b",
  "inline_breaking_disposition": "blocked",
  "inline_breaking_act_ids": [
    "act_fetch-current",
    "act_evaluate"
  ],
  "standalone_breaking_receipt_id": "sha256:c03a3941950453ce03734de1fa48ab43e5658c70b497267b7e6813f1c42d579e",
  "standalone_breaking_disposition": "blocked",
  "standalone_unreachable_receipt_id": "sha256:26f6923da81dd6aa000f2a9bc11f1f474627b1d608aeae3935328efa8f328710",
  "standalone_unreachable_disposition": "failed",
  "standalone_refusal_expected_steps": [
    "fetch-current",
    "evaluate"
  ],
  "refusal_contains_append_or_readback": false,
  "store_files": [
    "schema-guard-task3-compatible-2245327-v1.json"
  ],
  "stored_event_count": 1,
  "stored_event": {
    "type": "schema.version.recorded",
    "source": {
      "content_digest": "sha256:12afb28f78d480caf2aa7056f1fae44c08b2e30fb741b30368d18c939a26eebb",
      "final_url": "https://raw.githubusercontent.com/qq2401672073-hub/runx/224532774bdf6067757cac84d15656029e4327db/skills/schema-guard/fixtures/current-invoice.schema.json"
    },
    "compatibility_digest": "sha256:f05997ced8921f626c0d9d089905d87c1b9bcf09213437916f45453f636d75cf",
    "proposed_schema_digest": "sha256:fb3238374fc95b046180386fd5a4613fb5ea311f4b8fd8434000e7b6855de52e",
    "event_digest": "sha256:3fb19aebb53c7d258df2640ff84389959cb0a2c0b5331da91205abaf2183ccde",
    "validation_summary": {
      "invalid_count": 0,
      "sample_count": 1,
      "sample_coverage_supplied": true,
      "valid_count": 1
    }
  }
}
```

This proves that compatible execution contains fetch, append, and readback
acts; the stored event binds the immutable source digest and compatibility
verdict digest; breaking execution contains only fetch/evaluate; the failed
unreachable receipt expects only fetch/evaluate; and no breaking or unreachable
store file was created.

## Vendored dependency integrity

SHA-256 parity checks passed for every copied runtime file:

- `graph/web-fetch/{X.yaml,SKILL.md,run.mjs}` exactly match
  `skills/web-fetch/`;
- `graph/data-store/{X.yaml,SKILL.md}` exactly match `skills/data-store/`;
- all local, SQLite, and Redis manifest, adapter, and README files under
  `graph/data-store/tools/` exactly match `skills/data-store/tools/`.

No graph step references `../web-fetch`, `../data-store`, or an installed
registry package.

## Additional check note

`pnpm authoring:check-package-contract` could not start because the pre-existing
workspace artifact `packages/authoring/dist/index.js` is absent. It failed with
`ENOENT` before inspecting this package and changed no retained file. This was
not one of the operator's final Task 3 commands; the required unit, current-CLI
harness, receipt/effect assertions, and diff checks are recorded above and
below.

The signed commit containing this report cannot self-reference its own Git
object id. The final commit SHA is reported by the completing agent after the
commit is created.
