---
"@molpha-oracle/sdk": minor
---

make subscription payment explicit on `subscribe`/`extendSubscription`

`subscribe` and `extendSubscription` now require a `maxPriceUsdc` confirmation
(USDC base units) so callers explicitly acknowledge the on-chain USDC charge.
The SDK reads the live plan price and aborts before sending the transaction if
it exceeds the confirmed maximum, and returns the amount charged as `pricePaid`.
Added `getPlan(plan)` to fetch the current price/terms for display beforehand.
