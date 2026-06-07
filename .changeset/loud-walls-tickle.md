---
"@molpha-oracle/sdk": patch
---

improve gateway execution reliability and align API config hash defaults

`canonicalizeAPIConfig` now defaults `valueTransform` to an empty string instead of `multiply:1e6`, so API config hashing reflects explicit transforms only. Gateway execution now retries job-config fetches on transient `404` responses for newly created jobs, and gateway errors include backend-provided details for easier debugging of `400`, `503`, and other non-OK responses.
