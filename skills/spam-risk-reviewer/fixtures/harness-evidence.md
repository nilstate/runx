# Spam Risk Reviewer Harness Evidence

- `low-risk-verified-sender` covers a fully authenticated sender, fresh list, low bounce rate, low complaint rate, and sufficient warm-up.
- `high-risk-incomplete-auth-poor-list` covers failed DKIM, bounce rate above policy, complaint rate above policy, stale list age, short warm-up, and urgency content flags.
- Both fixtures are pure read-only metadata and contain no credentials, subscriber addresses, or message body content.
- The skill emits `send_risk_verdict` only. It does not create a public send effect.
