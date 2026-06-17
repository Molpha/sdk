# @molpha-oracle/sdk

## 0.4.1

### Patch Changes

- dc65759: update the default gateway endpoint to `https://gateway.molpha.io`

  `DEFAULT_GATEWAY_ENDPOINT` now points at the production Molpha gateway instead of the
  previous dev IP address.

## 0.4.0

### Minor Changes

- 113b5d3: add a cached-context "short" flow to `MolphaGateway.requestSignedData`

  Introduce `RoundContext` (`registryVersion`, `nodes`, `jobConfig`) and a
  `gateway.prepareContext(jobId)` helper that fetches these slow-changing round
  inputs once. Pass them back via `requestSignedData({ ..., context })` (also
  accepted by `requestAndSubmit`) to skip the prelude and run rounds as a single
  gateway POST. `context` is partial, so any omitted field is still fetched. The
  default full flow now also fetches the registry version, node set, and job
  config in parallel.

- d916cd6: rename the gateway round APIs to reflect that they request signed data

  The gateway never executes anything on-chain — it returns a threshold-signed
  data update. The methods and types are renamed accordingly:

  - `MolphaGateway.execute(...)` → `MolphaGateway.requestSignedData(...)`
  - `MolphaSDK.executeAndSubmit(...)` → `MolphaSDK.requestAndSubmit(...)`
  - `ExecuteOptions` → `RequestSignedDataOptions`
  - `ExecuteContext` → `RoundContext`

  The gateway HTTP route (`POST /v1/jobs/{id}/execute`) is unchanged.

### Patch Changes

- a1c15a5: wire wallet auth into `MolphaSDK.gateway.requestSignedData`

  `MolphaSDK` now passes the wallet's gateway signer to `MolphaGateway` as its
  default, so `sdk.gateway.requestSignedData({ jobId, apiConfig })` authenticates
  without an explicit `signer`. Per-call `signer` still overrides the default.
  Standalone `MolphaGateway` accepts an optional third `defaultSigner` constructor
  argument; omitting it keeps the all-zero dev `authSig` behavior.

## 0.3.2

### Patch Changes

- 9211268: ci: verify dev snapshot pipeline increments above latest

## 0.3.1

### Patch Changes

- a1c15a5: wire wallet auth into `MolphaSDK.gateway.execute`

  `MolphaSDK` now passes the wallet's gateway signer to `MolphaGateway` as its
  default, so `sdk.gateway.execute({ jobId, apiConfig })` authenticates without
  an explicit `signer`. Per-call `signer` still overrides the default.
  Standalone `MolphaGateway` accepts an optional third `defaultSigner` constructor
  argument; omitting it keeps the all-zero dev `authSig` behavior.

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
