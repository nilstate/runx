# Frantic #34 submit commands

These commands are intentionally not run automatically because they create
public GitHub, runx registry, and Frantic claim/delivery records.

```bash
git switch -c frantic-34-inbox-triage
git add skills/inbox-triage
git commit -m "Add inbox-triage runx skill"
git push -u <fork-remote> frantic-34-inbox-triage
gh pr create \
  --repo runxhq/runx \
  --base main \
  --head <owner>:frantic-34-inbox-triage \
  --title "Add inbox-triage runx skill" \
  --body-file skills/inbox-triage/evidence/frantic-34-pr-body.md
```

After the public PR exists:

```bash
runx login --provider github --for publish
runx registry publish ./skills/inbox-triage/SKILL.md --registry https://api.runx.ai
runx registry read <owner>/inbox-triage@0.1.0 --json
runx add <owner>/inbox-triage@0.1.0
runx skill <owner>/inbox-triage@0.1.0 --json
runx verify --receipt <receipt.json> --json
```

Then replace the placeholders in
`skills/inbox-triage/evidence/frantic-34-delivery-packet.template.txt` and run
Frantic preflight before delivery.
