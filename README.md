# @molpha/sdk

Browser-first TypeScript SDK for **Molpha data consumers and feed owners**.

**Detailed reference:** [docs/SDK.md](./docs/SDK.md) (API surface, types, EVM/Starknet helpers, end-to-end flow).

Use it to:

- subscribe to a Molpha plan on Solana;
- derive a feed id from owner + API config hash + quorum;
- request a threshold-signed data update from the gateway;
- submit the signed result on-chain;
- verify/read the latest feed value;
- build EVM and Starknet verifier arguments from the same signed result.

**Runtime:** Node.js `>=20.19.0` (ESM).

## Protocol model

Molpha turns off-chain API responses into verified on-chain data.

At a high level:

```text
Consumer / feed owner
  └─ subscribes (USDC) on Solana
  └─ derives feedId from owner + apiConfigHash + signaturesRequired

Gateway
  └─ coordinates a signing round for a feedId

Verifier nodes
  └─ fetch/recompute the API result independently
  └─ sign the canonical result if valid

Solana / EVM / Starknet verifiers
  └─ verify quorum, registry version, signer bitmap, timestamp, and aggregate signature
  └─ finalize or expose the verified value
```

The gateway is a coordination layer, not a trusted oracle. A result is trusted only if it carries a valid threshold signature from the selected verifier nodes for the current registry version.

Molpha uses Solana as the canonical protocol chain for subscriptions, registry state, node accounts, and feed state. EVM and Starknet verifier contracts are stateless verification surfaces: they verify signed Molpha data updates without managing subscriptions or feed configuration locally.

## Install

```bash
pnpm add @molpha/sdk
```

Runtime dependencies include `@solana/kit`, `@anchor-lang/core`, and `@noble/*`. `bn.js` is an optional peer dependency (used by the Solana / Anchor path).

> **Migration from `@molpha-oracle/sdk`:** The package was renamed to `@molpha/sdk` starting at `0.1.0`. `@molpha-oracle/sdk` is deprecated — update install commands and imports:
>
> ```bash
> pnpm remove @molpha-oracle/sdk
> pnpm add @molpha/sdk
> ```
>
> Replace `@molpha-oracle/sdk` with `@molpha/sdk` in all import paths (including `@molpha/sdk/utils`).

| Import | Use |
|---|---|
| `@molpha/sdk` | Facade (`MolphaSDK`), `MolphaGateway`, `MolphaSolanaClient`, core types, EVM/Starknet helpers. Browser-safe; no `fs` in the main entry. |
| `@molpha/sdk/utils` | `walletFromKeypairFile`, `loadKeypair` — load a Solana CLI keypair as an Anchor `Wallet`. Node.js only. |

The package is ESM with `"sideEffects": false`, so gateway-only or read-only apps can tree-shake unused paths.

## Quick start

```ts
import { web3 } from "@anchor-lang/core";
import {
  MolphaSDK,
  PlanType,
  deriveApiConfigHash,
  deriveFeedIdString,
} from "@molpha/sdk";
import { walletFromKeypairFile } from "@molpha/sdk/utils";

const wallet = walletFromKeypairFile("~/.config/solana/id.json");
const sdk = new MolphaSDK({
  connection: new web3.Connection("https://api.devnet.solana.com", "confirmed"),
  wallet,
});

// Subscribe if needed (USDC on Solana)
const plan = await sdk.solana.getPlan(PlanType.Basic);
await sdk.solana.subscribe(PlanType.Basic, {
  maxPriceUsdc: plan.subscriptionPrice,
});

const apiConfig = {
  url: "https://api.example.com/price",
  responseParser: "$.price",
};
const signaturesRequired = 3;
const feedId = deriveFeedIdString(
  wallet.publicKey.toBytes(),
  deriveApiConfigHash(apiConfig),
  signaturesRequired,
);

const { result, signature } = await sdk.requestAndSubmit(feedId, {
  apiConfig,
  signaturesRequired,
});
```

`requestAndSubmit` requests a threshold-signed data update from the gateway (against the current on-chain registry version) and submits it to Solana in one call. The first successful submit creates the feed account if it does not already exist.

## Configuration

### Required

| Option | Description |
|---|---|
| `connection` | Anchor-compatible Solana RPC connection. |
| `wallet` | [`MolphaWallet`](#wallet). Used for Solana transactions and gateway authentication when available. |

### Optional

| Option | Default |
|---|---|
| `endpoints` | `DEFAULT_GATEWAY_ENDPOINT` — string or array for failover |
| `programId` | `MOLPHA_PROGRAM_ADDRESS` from the vendored IDL |
| `idl` | `MOLPHA_IDL` from `idl/molpha.json` |
| `commitment` | `"confirmed"` |

```ts
import {
  DEFAULT_GATEWAY_ENDPOINT,
  MOLPHA_IDL,
  MOLPHA_PROGRAM_ADDRESS,
} from "@molpha/sdk";

const sdk = new MolphaSDK({
  connection,
  wallet,
  endpoints: [DEFAULT_GATEWAY_ENDPOINT, "https://backup.example.com"],
  // programId: "YourProgramAddress...",
  // idl: MOLPHA_IDL,
});
```

## Wallet

`wallet` is a single `MolphaWallet` used across both protocol surfaces:

| Layer | What it signs |
|---|---|
| Solana client | Transactions such as `subscribe`, `extendSubscription`, `submitDataUpdate` |
| Gateway client | `authMessage(feedId, timestamp)` for authenticated gateway requests |

Gateway auth is resolved automatically when you use `MolphaSDK`:

1. Use `wallet.signAuthMessage` if provided.
2. Else derive signing from Anchor `Wallet.payer` when the secret key is available, such as with `walletFromKeypairFile`.
3. Else omit auth and use an all-zero `authSig`.

`MolphaSDK` passes the resolved signer to `sdk.gateway` as its default, so
`sdk.gateway.requestSignedData({ feedId, apiConfig, signaturesRequired })` authenticates without an
explicit `signer`. Standalone `new MolphaGateway(...)` omits auth unless you pass
a `defaultSigner` (third constructor arg) or per-call `signer`.

The all-zero `authSig` path is for development only. Production jobs should authenticate gateway requests.

### Node.js utility

```ts
import { walletFromKeypairFile } from "@molpha/sdk/utils";

const wallet = walletFromKeypairFile("~/.config/solana/id.json");
```

### Browser wallet adapter

```ts
import type { MolphaWallet } from "@molpha/sdk";

const wallet: MolphaWallet = {
  publicKey: adapter.publicKey,
  signTransaction: (tx) => adapter.signTransaction(tx),
  signAllTransactions: (txs) => adapter.signAllTransactions(txs),
  signAuthMessage: async (msg) => new Uint8Array(await adapter.signMessage(msg)),
};
```

You can also override gateway auth per call with `gateway.requestSignedData({ ..., signer })` or with the same field in `requestAndSubmit`.

## Core flow

Use `MolphaSDK` for the end-to-end path, or use `MolphaSolanaClient` / `MolphaGateway` separately when you only need one side.

```ts
import { web3 } from "@anchor-lang/core";
import {
  MolphaSDK,
  PlanType,
  deriveApiConfigHash,
  deriveFeedIdString,
} from "@molpha/sdk";
import { walletFromKeypairFile } from "@molpha/sdk/utils";

const sdk = new MolphaSDK({
  connection: new web3.Connection("https://api.devnet.solana.com", "confirmed"),
  wallet: walletFromKeypairFile("~/.config/solpha/id.json"),
});
```

### 1. Subscribe

Subscriptions are paid in USDC on Solana.

For local/dev testing on Solana Devnet, you can request test USDC from Circle's faucet: [https://faucet.circle.com/](https://faucet.circle.com/) (select `USDC` on `Solana Devnet`).

```ts
const plan = await sdk.solana.getPlan(PlanType.Basic);

// Show plan.subscriptionPrice to the user before charging.
const { pricePaid } = await sdk.solana.subscribe(PlanType.Basic, {
  maxPriceUsdc: plan.subscriptionPrice,
});
```

`maxPriceUsdc` is a safety bound. The transaction aborts if the live plan price is higher than the amount the user approved.

### 2. Derive a feed id

There is no separate `createJob` instruction. Feed identity is deterministic:

```text
feedId = keccak256("MOLPHA_JOB_V1" || owner || apiConfigHash || [signaturesRequired])
```

```ts
const apiConfig = {
  url: "https://api.example.com/price",
  responseParser: "$.price",
};

const signaturesRequired = 3;
const feedId = deriveFeedIdString(
  wallet.publicKey.toBytes(),
  deriveApiConfigHash(apiConfig),
  signaturesRequired,
);
```

The on-chain feed commits to the `apiConfigHash`, not the full API config. This binds the feed to a specific off-chain data source and parsing logic while keeping large config payloads and secrets off-chain. Pass the same `apiConfig` (including `{{secret.*}}` placeholders) to gateway requests that you hashed when deriving the feed id.

### 3. Request signed data from the gateway

```ts
const result = await sdk.gateway.requestSignedData({
  feedId,
  apiConfig,
  signaturesRequired,
});
```

The gateway round uses the current on-chain registry version. Selected verifier nodes independently fetch/recompute the result and sign only if the observed value matches the canonical result.

The returned `DataUpdateResult` includes the signed value, canonical timestamp, registry version, required quorum, signer bitmap, and aggregate signature.

### 4. Submit on Solana

```ts
const { signature } = await sdk.solana.submitDataUpdate(result);
```

Then read the finalized feed:

```ts
const feed = await sdk.solana.readFeed(feedId);
```

### One-call request + submit

```ts
const { result, signature } = await sdk.requestAndSubmit(feedId, {
  apiConfig,
  signaturesRequired,
});
```

This is equivalent to:

```ts
const result = await sdk.gateway.requestSignedData({ feedId, apiConfig, signaturesRequired });
const { signature } = await sdk.solana.submitDataUpdate(result);
```

### Fast requests with a cached context

By default every `requestSignedData` call fetches slow-changing inputs up
front (in parallel): the on-chain registry version and redundancy buffer (one
account read), and the node set. When you run many rounds for the same feed,
fetch these once and reuse them so each round is a single gateway POST.

```ts
// Fetch registryVersion + redundancyBuffer + nodes once.
const context = await sdk.gateway.prepareContext(feedId);

// Reuse it across rounds — no prelude fetches.
const result = await sdk.gateway.requestSignedData({ feedId, apiConfig, signaturesRequired, context });
```

`context` is a `Partial<RoundContext>`, so you can cache only what you have
and let `requestSignedData` fetch the rest:

```ts
const result = await sdk.gateway.requestSignedData({
  feedId,
  apiConfig,
  signaturesRequired,
  context: { nodes }, // registryVersion + redundancyBuffer still fetched fresh
});
```

Caching is opt-in because these inputs can drift. A stale `registryVersion`,
`redundancyBuffer`, or node set yields a result the chain will reject — refresh
the context when the on-chain registry changes. The same `context` field is
accepted by `requestAndSubmit`.

## Private APIs and encrypted secrets

Jobs can use private APIs without sending plaintext secrets to the gateway.

```ts
const result = await sdk.gateway.requestSignedData({
  feedId,
  apiConfig: {
    url: "https://api.example.com/private-price?key={{secret.apiKey}}",
    responseParser: "$.price",
  },
  signaturesRequired,
  encrypt: {
    secrets: {
      apiKey: process.env.API_KEY!,
    },
  },
});
```

`MolphaSDK` wires `verifyNodeKeys` to `solana.verifyNodeKeysForPrivateApi`, which authenticates gateway node encryption keys against on-chain Node accounts before secrets are encrypted.

Secrets are encrypted into per-node envelopes. The gateway coordinates the round but should not receive plaintext API credentials.

Private API access is still an active security-sensitive surface. Do not treat encrypted secret delivery as production-ready until gateway/node-side test vectors and validation are complete.

## EVM verification

After a gateway round, the same signed result can be verified on EVM chains.

The SDK ships deployed testnet verifier addresses and framework-agnostic tuple builders. It does not depend on ethers or viem at runtime.

### Deployed verifier address

The verifier is deployed with CREATE2 so the contract address is the same on every
supported EVM chain.

```ts
import { MOLPHA_VERIFIER_ADDRESS } from "@molpha/sdk";

const address = MOLPHA_VERIFIER_ADDRESS;
```

Supported network ids (selection helpers only): `evm-sepolia`, `arbitrum-sepolia`, `avalanche-fuji`, `bsc-testnet`.

### Build verifier arguments

```ts
import { buildEvmVerifierArgs } from "@molpha/sdk";

const result = await sdk.gateway.requestSignedData({ feedId, apiConfig, signaturesRequired });

const { dataUpdate, signature } = buildEvmVerifierArgs(result);
```

The generated tuples match the Molpha EVM verifier ABI:

```ts
// dataUpdate:
// [bytes32 feedId,
//  uint32 registryVersion,
//  uint32 signaturesRequired,
//  bytes32 valuePacked,
//  uint64 timestamp]

// signature:
// [bytes32 s,
//  address commitment,
//  uint256 signersBitmap]
```

Note: the shipped `MOLPHA_VERIFIER_ABI` still names the first struct field `jobId` for contract compatibility; the SDK value is the feed id bytes32.

### ethers

```ts
import { Contract } from "ethers";
import {
  buildEvmVerifierArgs,
  MOLPHA_VERIFIER_ADDRESS,
} from "@molpha/sdk";

const verifier = new Contract(
  MOLPHA_VERIFIER_ADDRESS,
  abi,
  signer,
);

const { dataUpdate, signature } = buildEvmVerifierArgs(result);

await verifier.verify(dataUpdate, signature);
```

### viem

```ts
import { createPublicClient, http } from "viem";
import {
  buildEvmVerifierArgs,
  MOLPHA_VERIFIER_ABI,
  MOLPHA_VERIFIER_ADDRESS,
} from "@molpha/sdk";

const client = createPublicClient({
  chain,
  transport: http(),
});

const { dataUpdate, signature } = buildEvmVerifierArgs(result);

await client.readContract({
  address: MOLPHA_VERIFIER_ADDRESS,
  abi: MOLPHA_VERIFIER_ABI,
  functionName: "verify",
  args: [
    {
      jobId: dataUpdate[0],
      registryVersion: dataUpdate[1],
      signaturesRequired: dataUpdate[2],
      value: dataUpdate[3],
      canonicalTimestamp: BigInt(dataUpdate[4]),
    },
    {
      signature: signature[0],
      commitment: signature[1],
      signersBitmap: signature[2],
    },
  ],
});
```

Lower-level helpers are also exported for manual integrations:

```ts
import {
  toFixedHex,
  signersBitmapToUint256,
  signersBitmapToDecimal,
} from "@molpha/sdk";
```

## Starknet verification

After a gateway round, the same signed result can be verified on Starknet.

The SDK ships deployed testnet verifier addresses and framework-agnostic struct
builders. It does not depend on `starknet.js` at runtime.

### Deployed verifier addresses

```ts
import {
  MOLPHA_VERIFIER_STARKNET_ADDRESSES,
  MOLPHA_VERIFIER_STARKNET_SEPOLIA,
  getMolphaStarknetVerifierAddress,
} from "@molpha/sdk";

const address = getMolphaStarknetVerifierAddress("starknet-sepolia");

// or:
const sepolia = MOLPHA_VERIFIER_STARKNET_ADDRESSES["starknet-sepolia"];
const sepoliaDirect = MOLPHA_VERIFIER_STARKNET_SEPOLIA;
```

| Network | Constant |
|---|---|
| Starknet Sepolia | `MOLPHA_VERIFIER_STARKNET_SEPOLIA` |

### Build verifier arguments

```ts
import { buildStarknetVerifierArgs } from "@molpha/sdk";

const result = await sdk.gateway.requestSignedData({ feedId, apiConfig, signaturesRequired });

const { dataUpdate, signature } = buildStarknetVerifierArgs(result);
```

The generated objects match the Molpha Starknet verifier interface:

```ts
// dataUpdate:
// {
//   feed_id: u256,
//   registry_version: u32,
//   signatures_required: u32,
//   value: u256,
//   canonical_timestamp: u64,
// }

// signature:
// {
//   signature: u256,
//   commitment: felt252, // EVM-style 20-byte address as felt
//   signers_bitmap: u256,
// }
```

Lower-level helpers are also exported:

```ts
import {
  commitmentAddressToStarknetFelt,
  signersBitmapToStarknetUint256,
} from "@molpha/sdk";
```

## What verification checks

A Molpha data update is valid only if the verifier can confirm:

- the update targets the expected `feedId`;
- the result was signed against a specific `registryVersion`;
- the quorum satisfies `signaturesRequired`;
- the signer bitmap maps to valid selected nodes;
- the aggregate Schnorr signature is valid;
- the signed value and canonical timestamp match the message;
- the timestamp is within the accepted freshness bounds;
- on Solana, remaining accounts resolve correctly for the registry version (including previous-version remap during transitions).

Solana verification finalizes feed state via `submit_data_update`. EVM and Starknet verification are stateless and return whether the signed Molpha update is valid for the deployed verifier registry.

## IDL vendoring

The Solana client needs the Anchor IDL for the Molpha program.

A vendored copy ships under `idl/` and is used by default:

```ts
import { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "@molpha/sdk";
```

Override `idl` and `programId` when targeting another deployment.

Keep the vendored IDL aligned with the deployed program. Mismatched IDL/program versions can produce invalid account derivations, decoding errors, or failed instruction simulation.

## Standalone clients

`MolphaSDK` is a convenience facade.

You can also use the lower-level clients directly:

```ts
import {
  MolphaGateway,
  MolphaSolanaClient,
  gatewaySignerFromWallet,
} from "@molpha/sdk";

const solana = MolphaSolanaClient.create({
  connection,
  wallet,
});

const gateway = new MolphaGateway(
  endpoints,
  () => solana.getRegistrySelectionConfig(),
  gatewaySignerFromWallet(wallet),
  {
    defaultSubscriptionOwner: wallet.publicKey.toBase58(),
    verifyNodeKeys: (args) => solana.verifyNodeKeysForPrivateApi(args),
  },
);
```

The facade wires the registry selection config resolver, gateway signer, subscription owner, and node-key verifier automatically.

## Status

`0.0.0` (unreleased) — first stable release `@molpha/sdk@0.1.0` is pending via changesets.

Current scope:

- Solana subscription and extend flow;
- deterministic feed ID derivation;
- gateway signed-data requests (failover, retries, context cache);
- Solana data update submission and feed reads;
- private API encryption helpers (pre-production);
- EVM and Starknet verifier argument building;
- deployed testnet verifier address helpers.

Known limitations:

- private API envelope encryption still needs gateway/node-side test-vector validation;
- verifier-node registration and admin tooling are intentionally outside this package;
- production deployments should use authenticated gateway requests;
- testnet verifier addresses may change between protocol releases.

Solana paths such as selection bitmap, previous-version remap, and `submit_data_update` remaining-accounts resolution are aligned with the Molpha program version vendored in this repo.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm e2e-demo
```

## Releasing

Versioning and publishing are automated with Changesets.

Versions follow semver and are driven by the nature of each change, not by the branch it merges from.

### Workflow

1. Add a changeset with your change:

   ```bash
   pnpm changeset
   ```

   Choose:

   - `patch` for fixes;
   - `minor` for features;
   - `major` for breaking changes.

   While the package is pre-`1.0.0`, use `minor` for breaking changes and `patch` for features/fixes. Only select `major` when intentionally cutting `1.0.0`.

2. Stable releases from `main`

   When changes land on `main`, the release workflow opens a release PR that bumps `package.json` and updates `CHANGELOG.md`.

   Merging that PR publishes to npm on the `latest` tag:

   ```bash
   npm install @molpha/sdk
   ```

3. Prereleases from `dev`

   Pushes to `dev` publish a snapshot version on the `dev` dist-tag, for example:

   ```text
   0.2.0-dev-<timestamp>
   ```

   Install with:

   ```bash
   npm install @molpha/sdk@dev
   ```

   Requires at least one pending changeset.

### One-time setup

1. Add `NPM_TOKEN` under GitHub repo settings:

   ```text
   Settings → Secrets and variables → Actions
   ```

   Use a granular npm automation token with publish access to the `@molpha` scope.

2. Publish a stable release from `main` first.

   npm assigns the first published version to the `latest` tag regardless of `--tag`. If a `dev` snapshot is published before any stable release, that prerelease can become `latest`.

   The `dev` workflow should guard against this and fail until a stable `latest` exists.

3. Deprecate the legacy package name on npm (one-time, after `@molpha/sdk@0.1.0` is published):

   ```bash
   npm deprecate "@molpha-oracle/sdk" "Package renamed to @molpha/sdk. Please migrate."
   ```

If `latest` ever points to a prerelease, repoint it after publishing a stable version:

```bash
npm dist-tag add @molpha/sdk@<stable-version> latest
```
