# @molpha-oracle/sdk

## 0.3.0

### Minor Changes

- b381ffe: add EVM verifier address constants and tuple helpers

  Export deployed Molpha verifier addresses for Ethereum Sepolia, Arbitrum Sepolia,
  Avalanche Fuji, and BSC testnet, plus framework-agnostic helpers to convert
  `DataUpdateResult` into `verify(DataUpdate, SchnorrSignature)` contract arguments
  for use with ethers or viem.

- 113b5d3: add a cached-context "short" flow to `MolphaGateway.execute`

  Introduce `ExecuteContext` (`registryVersion`, `nodes`, `jobConfig`) and a
  `gateway.prepareContext(jobId)` helper that fetches these slow-changing round
  inputs once. Pass them back via `execute({ ..., context })` (also accepted by
  `executeAndSubmit`) to skip the prelude and run rounds as a single gateway POST.
  `context` is partial, so any omitted field is still fetched. The default full
  flow now also fetches the registry version, node set, and job config in
  parallel.

### Patch Changes

- b381ffe: improve gateway execution reliability and align API config hash defaults

  `canonicalizeAPIConfig` now defaults `valueTransform` to an empty string instead of `multiply:1e6`, so API config hashing reflects explicit transforms only. Gateway execution now retries job-config fetches on transient `404` responses for newly created jobs, and gateway errors include backend-provided details for easier debugging of `400`, `503`, and other non-OK responses.

- 113b5d3: add Starknet verifier address helpers and calldata builders

  Expose the deployed Starknet Sepolia verifier address and helpers to convert a
  gateway `DataUpdateResult` into Starknet verifier `DataUpdate` and
  `SchnorrSignature` calldata structs.

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
