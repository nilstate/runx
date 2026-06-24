# Dependency Advisory Graph Report

Project: eclipse-theia/security-audit
Project URL: https://github.com/eclipse-theia/security-audit
Lockfile source: https://raw.githubusercontent.com/eclipse-theia/security-audit/master/package-lock.json
Ecosystem: npm
Advisory source: https://api.osv.dev/v1/querybatch
Retrieved at: 2026-06-24T00:25:58.356Z

## Findings

- brace-expansion@1.1.11: GHSA-f886-m6hf-6m8v, severity unknown, fix not listed, direct dependency to bump tslint, evidence https://osv.dev/vulnerability/GHSA-f886-m6hf-6m8v
  - Fix path: Bump tslint to a version outside the OSV affected range for GHSA-f886-m6hf-6m8v.
- brace-expansion@1.1.11: GHSA-v6h2-p8h4-qcjw, severity unknown, fix not listed, direct dependency to bump tslint, evidence https://osv.dev/vulnerability/GHSA-v6h2-p8h4-qcjw
  - Fix path: Bump tslint to a version outside the OSV affected range for GHSA-v6h2-p8h4-qcjw.
- diff@4.0.1: GHSA-73rr-hh4g-fpgx, severity unknown, fix not listed, direct dependency to bump tslint, evidence https://osv.dev/vulnerability/GHSA-73rr-hh4g-fpgx
  - Fix path: Bump tslint to a version outside the OSV affected range for GHSA-73rr-hh4g-fpgx.
- js-yaml@3.13.1: GHSA-h67p-54hq-rp68, severity unknown, fix not listed, direct dependency to bump tslint, evidence https://osv.dev/vulnerability/GHSA-h67p-54hq-rp68
  - Fix path: Bump tslint to a version outside the OSV affected range for GHSA-h67p-54hq-rp68.
- js-yaml@3.13.1: GHSA-mh29-5h37-fv8m, severity unknown, fix not listed, direct dependency to bump tslint, evidence https://osv.dev/vulnerability/GHSA-mh29-5h37-fv8m
  - Fix path: Bump tslint to a version outside the OSV affected range for GHSA-mh29-5h37-fv8m.
- minimatch@3.0.4: GHSA-23c5-xmqv-rm74, severity unknown, fix not listed, direct dependency to bump tslint, evidence https://osv.dev/vulnerability/GHSA-23c5-xmqv-rm74
  - Fix path: Bump tslint to a version outside the OSV affected range for GHSA-23c5-xmqv-rm74.
- minimatch@3.0.4: GHSA-3ppc-4f35-3m26, severity unknown, fix not listed, direct dependency to bump tslint, evidence https://osv.dev/vulnerability/GHSA-3ppc-4f35-3m26
  - Fix path: Bump tslint to a version outside the OSV affected range for GHSA-3ppc-4f35-3m26.
- minimatch@3.0.4: GHSA-7r86-cg39-jmmj, severity unknown, fix not listed, direct dependency to bump tslint, evidence https://osv.dev/vulnerability/GHSA-7r86-cg39-jmmj
  - Fix path: Bump tslint to a version outside the OSV affected range for GHSA-7r86-cg39-jmmj.
- minimatch@3.0.4: GHSA-f8q6-p94x-37v3, severity unknown, fix not listed, direct dependency to bump tslint, evidence https://osv.dev/vulnerability/GHSA-f8q6-p94x-37v3
  - Fix path: Bump tslint to a version outside the OSV affected range for GHSA-f8q6-p94x-37v3.
- minimist@0.0.8: GHSA-vh95-rmgr-6w4m, severity unknown, fix not listed, direct dependency to bump tslint, evidence https://osv.dev/vulnerability/GHSA-vh95-rmgr-6w4m
  - Fix path: Bump tslint to a version outside the OSV affected range for GHSA-vh95-rmgr-6w4m.
- minimist@0.0.8: GHSA-xvch-5gv4-984h, severity unknown, fix not listed, direct dependency to bump tslint, evidence https://osv.dev/vulnerability/GHSA-xvch-5gv4-984h
  - Fix path: Bump tslint to a version outside the OSV affected range for GHSA-xvch-5gv4-984h.
- path-parse@1.0.6: GHSA-hj48-42vr-x3v9, severity unknown, fix not listed, direct dependency to bump tslint, evidence https://osv.dev/vulnerability/GHSA-hj48-42vr-x3v9
  - Fix path: Bump tslint to a version outside the OSV affected range for GHSA-hj48-42vr-x3v9.
- semver@5.7.1: GHSA-c2qf-rxjj-qqgw, severity unknown, fix not listed, direct dependency to bump tslint, evidence https://osv.dev/vulnerability/GHSA-c2qf-rxjj-qqgw
  - Fix path: Bump tslint to a version outside the OSV affected range for GHSA-c2qf-rxjj-qqgw.

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
