# @molpha-oracle/sdk

## 0.2.0

### Minor Changes

- d843e36: add `readPlan`, `readSubscription`, and `readJob` on `MolphaSolanaClient`

  On-chain read helpers for plan, subscription, and job accounts (nullable, like
  `readFeed`). `getPlan` now delegates to `readPlan` and throws when missing.

- 4e48226: make subscription payment explicit on `subscribe`/`extendSubscription`

  `subscribe` and `extendSubscription` now require a `maxPriceUsdc` confirmation
  (USDC base units) so callers explicitly acknowledge the on-chain USDC charge.
  The SDK reads the live plan price and aborts before sending the transaction if
  it exceeds the confirmed maximum, and returns the amount charged as `pricePaid`.
  Added `getPlan(plan)` to fetch the current price/terms for display beforehand.

### Patch Changes

- 8f90138: require maxPriceUsdc confirmation for subscribe/extend
- 48878d9: align `deriveApiConfigHash` with node hashing (`keccak256(JSON.stringify(canonicalApiConfig))`)

  API config hashing now matches node-side verification by hashing the canonicalized
  config JSON string directly (with SDK defaults applied), instead of JCS.

- 41b0816: simplify sdk init, add api-config hasher
