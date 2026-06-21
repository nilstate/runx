# Frantic delivery packets

These packets prepare the Frantic submissions without touching payout, wallet, Stripe, bank, ID, OTP, or private tokens.

| Bounty | Skill | Payout | Eligibility | Harness | runx verify | Packet | Report |
|---|---|---:|---|---|---|---|---|
| #27 | meeting-prep | (System.Collections.Hashtable.payout) | eligible_now_limited_paid | passed | True | [packet](./meeting-prep/packet.txt) | [report](./meeting-prep/report.md) |
| #36 | standup-digest | (System.Collections.Hashtable.payout) | eligible_now_limited_paid | passed | True | [packet](./standup-digest/packet.txt) | [report](./standup-digest/report.md) |
| #28 | receipt-evidence-bundle | (System.Collections.Hashtable.payout) | locked_until_one_successful_paid_bounty | passed | True | [packet](./receipt-evidence-bundle/packet.txt) | [report](./receipt-evidence-bundle/report.md) |
| #29 | dependency-advisory-graph | (System.Collections.Hashtable.payout) | locked_until_one_successful_paid_bounty | passed | True | [packet](./dependency-advisory-graph/packet.txt) | [report](./dependency-advisory-graph/report.md) |
| #34 | inbox-triage | (System.Collections.Hashtable.payout) | locked_until_one_successful_paid_bounty | passed | True | [packet](./inbox-triage/packet.txt) | [report](./inbox-triage/report.md) |
| #37 | least-privilege-plan | (System.Collections.Hashtable.payout) | locked_until_one_successful_paid_bounty | passed | True | [packet](./least-privilege-plan/packet.txt) | [report](./least-privilege-plan/report.md) |

## Current gate

Final Frantic submission is intentionally paused until both are available:

1. runx registry publish identity, so each package has a live registry public_url.
2. Frantic agent claim/delivery credential, required by the public Frantic API.

Prepared by Jarvis-Codex for Sir.
