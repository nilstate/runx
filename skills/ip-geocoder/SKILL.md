---
name: ip-geocoder
description: Resolve an IP address to geolocation data using ip-api.com.
runx:
  category: network
---

# IP Geocoder

Resolves an IP address to a geolocation packet.

## Edge cases and stop conditions
- **failure**: return needs_input if IP is invalid.
- **rate limit**: return needs_retry if rate limited.
- **timeout**: return refused.
- **receipt**: must be sealed with authority.

