# Data Doctor local harness

- CLI: `runx-cli 0.6.14`
- Command: `runx harness ./skills/data-doctor`
- Result: 3 cases passed with zero assertion errors.
- Quality-findings case covers missingness, duplicate ids, type drift, and numeric range anomalies.
- Healthy case produces zero findings and a healthy report.
- Missing-schema case stops at `needs_agent` before deterministic checks.
- Output is read-only and reports `dataset_mutated: false`.
