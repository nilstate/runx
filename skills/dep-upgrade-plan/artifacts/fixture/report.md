# Dependency upgrade plan report

- Target: Fixture Shop (https://github.com/RYDE-PLAY/runx-fixture-shop fixture-lock-v1)
- Lockfile: inline-json lockfile_json
- Lockfile SHA-256: 17716a543730ad8ac0bca4ea6bd7a475fd4277baa0bda4b624962cad757166c9
- Planned upgrades: 2
- Refused candidates: 1
- No package installation, manifest mutation, or target code execution was performed.
- Ranked plan:
  - lodash: 4.17.19 -> 4.17.21; risk=high; breaking=Patch-level update; no breaking change indicated by supplied notes.; advisory=GHSA-35jh-r3h4-6jhm
  - express: 4.16.4 -> 4.20.0; risk=low; breaking=Stays on Express 4.x; review response.redirect behavior and middleware compatibility.; advisory=GHSA-qw6h-vgh9-j6wx
- Changelog:
  - lodash: 4.17.19 -> 4.17.21 (high); Patch-level update; no breaking change indicated by supplied notes.
  - express: 4.16.4 -> 4.20.0 (low); Stays on Express 4.x; review response.redirect behavior and middleware compatibility.
