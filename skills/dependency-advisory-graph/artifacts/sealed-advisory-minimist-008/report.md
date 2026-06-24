# Dependency Advisory Graph Report

Project: fixture-vulnerable-app
Project URL: https://example.com/fixture-vulnerable-app
Lockfile source: fixtures/package-lock-advisory.json
Ecosystem: npm
Advisory source: https://api.osv.dev/v1/querybatch
Retrieved at: 2026-06-24T00:00:00.000Z

## Findings

- minimist@0.0.8: GHSA-vh95-rmgr-6w4m, severity critical, fix 0.2.1, direct dependency to bump minimist, evidence https://osv.dev/vulnerability/GHSA-vh95-rmgr-6w4m
  - Fix path: Bump minimist so minimist@0.0.8 is replaced by a non-vulnerable version; OSV first fixed version: 0.2.1.

## Verification

- typed_output_fields: pass
- real_lockfile_ingested: pass
- osv_advisory_source: pass
- exact_version_match: pass
- direct_dependency_fix_path: pass
- false_positive_guard: pass
- no_target_install_or_app_execution: pass

## Operator next steps

- Bump the listed direct_dependency_to_bump to a version that resolves the advisory.
- Regenerate the lockfile and re-run this skill against the updated lockfile.
- Attach the OSV evidence URL, fix path, and runx receipt to the dependency review record.
