---
"@molpha-oracle/sdk": minor
---

add `readPlan`, `readSubscription`, and `readJob` on `MolphaSolanaClient`

On-chain read helpers for plan, subscription, and job accounts (nullable, like
`readFeed`). `getPlan` now delegates to `readPlan` and throws when missing.
