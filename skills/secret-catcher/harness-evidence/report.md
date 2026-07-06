# Secret Catcher local harness

- CLI: `runx-cli 0.6.14`
- Command: `runx harness ./skills/secret-catcher`
- Result: passed, 2 cases, 0 assertion errors
- `block-planted-secret`: sealed with one redacted `secret_assignment` finding and `block: true`
- `allow-clean-diff`: sealed with zero findings and `block: false`
- Raw credential-like fixture values were absent from scanner output.
- The scanner performs no repository mutation and emits only a gated redaction proposal.
