---
name: lead-enrichment
description: Enrich a lead from supplied account signals and produce a reviewable outreach recommendation.
runx:
  category: growth
---

# Lead Enrichment

Turn supplied lead, account, and engagement signals into a reviewable enrichment
packet and outreach recommendation.

This skill does not scrape, email, or mutate CRM records. It works over context
that a consuming product has already hydrated through governed provider fronts.
The output is a human-reviewed recommendation, not permission to send.

Every enrichment claim and fit decision must cite a supplied signal; never infer
sensitive traits or fill missing firmographic data. Recommend the narrowest
useful follow-up for a well-supported fit. Return `needs_more_evidence` when the
signals are too thin and `do_not_contact` when consent, region, risk, or account
constraints make outreach inappropriate.

## Output

- `enriched_profile`: supplied and derived account facts with evidence refs.
- `fit_assessment`: evidence-backed fit, confidence, and caveats.
- `recommended_action`: hold, review, nurture, or a bounded follow-up.
- `risk_flags`: consent, sensitivity, and do-not-contact constraints.

## Inputs

- `lead` (required): lead identity and known account fields.
- `signals` (required): engagement, product, CRM, or firmographic signals.
- `constraints` (optional): allowed channels, region, opt-in, or do-not-contact
  flags.
