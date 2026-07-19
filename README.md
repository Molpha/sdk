# @molpha-oracle/sdk

Browser-first TypeScript SDK for **Molpha data consumers and job owners**.

Use it to:

- subscribe to a Molpha plan on Solana;
- create an oracle job from an API config hash;
- request a threshold-signed data update from the gateway;
- submit the signed result on-chain;
- verify/read the latest feed value;
- build EVM and Starknet verifier arguments from the same signed result.

## Protocol model

Molpha turns off-chain API responses into verified on-chain data.

At a high level:

```text
Job owner
  └─ creates job on Solana with apiConfigHash + quorum settings

Gateway
  └─ coordinates a round for a job

Verifier nodes
  └─ fetch/recompute the API result independently
  └─ sign the canonical result if valid

Solana / EVM / Starknet verifiers
  └─ verify quorum, registry version, signer bitmap, timestamp, and aggregate signature
  └─ finalize or expose the verified value
```

The gateway is a coordination layer, not a trusted oracle. A result is trusted only if it carries a valid threshold signature from the selected verifier nodes for the current registry version.

Molpha uses Solana as the canonical protocol chain for jobs, subscriptions, registry state, and feed state. EVM and Starknet verifier contracts are stateless verification surfaces: they verify signed Molpha data updates without needing to manage subscriptions or job configuration locally.

## Install

```bash
pnpm add @molpha-oracle/sdk
```

Solana support is optional and only needed for `MolphaSDK` / `MolphaSolanaClient`:

```bash
pnpm add @solana/web3.js @coral-xyz/anchor @solana/spl-token bn.js
```

| Import | Use |
|---|---|
| `@molpha-oracle/sdk` | Facade (`MolphaSDK`), `MolphaGateway`, `MolphaSolanaClient`, core types, EVM/Starknet helpers. Browser-safe; no `fs` in the main entry. |
| `@molpha-oracle/sdk/utils` | `walletFromKeypairFile` — load a Solana CLI keypair as an Anchor `Wallet`. Node.js only. |

The package is ESM with `"sideEffects": false`, so gateway-only or read-only apps can tree-shake the Anchor-heavy Solana path when they do not import it.

## Quick start

```ts
import { Connection } from "@solana/web3.js";
import { MolphaSDK } from "@molpha-oracle/sdk";
import { walletFromKeypairFile } from "@molpha-oracle/sdk/utils";

const sdk = new MolphaSDK({
  connection: new Connection("https://api.devnet.solana.com", "finalized"),
  wallet: walletFromKeypairFile("~/.config/solana/id.json"),
});

const { result, signature } = await sdk.requestAndSubmit(jobId, {
  apiConfig: {
    url: "https://api.example.com/price",
    responseParser: "$.price",
  },
});
```

`requestAndSubmit` requests a threshold-signed data update from the gateway (against the current on-chain registry version) and submits it to Solana in one call.

## Configuration

### Required

| Option | Description |
|---|---|
| `connection` | Solana RPC `Connection`. |
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
} from "@molpha-oracle/sdk";

const sdk = new MolphaSDK({
  connection,
  wallet,
  endpoints: [DEFAULT_GATEWAY_ENDPOINT, "https://backup.example.com"],
  // programId: new PublicKey("..."),
  // idl: MOLPHA_IDL,
});
```

## Wallet

`wallet` is a single `MolphaWallet` used across both protocol surfaces:

| Layer | What it signs |
|---|---|
| Solana client | Transactions such as `subscribe`, `createJob`, `submitDataUpdate` (plus simulation flows such as `verifyDataUpdate`) |
| Gateway client | `authMessage(jobId, timestamp)` for authenticated gateway requests |

Gateway auth is resolved automatically when you use `MolphaSDK`:

1. Use `wallet.signAuthMessage` if provided.
2. Else derive signing from Anchor `Wallet.payer` when the secret key is available, such as with `walletFromKeypairFile`.
3. Else omit auth and use an all-zero `authSig`.

`MolphaSDK` passes the resolved signer to `sdk.gateway` as its default, so
`sdk.gateway.requestSignedData({ jobId, apiConfig })` authenticates without an
explicit `signer`. Standalone `new MolphaGateway(...)` omits auth unless you pass
a `defaultSigner` (third constructor arg) or per-call `signer`.

The all-zero `authSig` path is for development only. Production jobs should authenticate gateway requests.

### Node.js utility

```ts
import { walletFromKeypairFile } from "@molpha-oracle/sdk/utils";

const wallet = walletFromKeypairFile("~/.config/solana/id.json");
```

### Browser wallet adapter

```ts
import type { MolphaWallet } from "@molpha-oracle/sdk";

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
import { Connection } from "@solana/web3.js";
import {
  MolphaSDK,
  PlanType,
  deriveApiConfigHash,
} from "@molpha-oracle/sdk";
import { walletFromKeypairFile } from "@molpha-oracle/sdk/utils";

const sdk = new MolphaSDK({
  connection: new Connection("https://api.devnet.solana.com", "confirmed"),
  wallet: walletFromKeypairFile("~/.config/solana/id.json"),
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

### 2. Create a job

```ts
const apiConfig = {
  url: "https://api.example.com/price",
  responseParser: "$.price",
};

const apiConfigHash = deriveApiConfigHash(apiConfig);

const { jobId } = await sdk.solana.createJob({
  apiConfigHash,
  signaturesRequired: 3,
  decimals: 8,
});
```

The on-chain job stores the `apiConfigHash`, not the full API config. This commits the job to a specific off-chain data source and parsing logic while keeping large config payloads and secrets off-chain.

### 3. Request signed data from the gateway

```ts
const result = await sdk.gateway.requestSignedData({
  jobId,
  apiConfig,
});
```

The gateway round uses the current on-chain registry version. Selected verifier nodes independently fetch/recompute the result and sign only if the observed value matches the canonical result.

The returned `DataUpdateResult` includes the signed value, canonical timestamp, registry version, required quorum, signer bitmap, and aggregate signature.

### 4. Submit or simulate on Solana

```ts
const { signature } = await sdk.solana.submitDataUpdate(result);
```

To simulate verification without submitting state:

```ts
const { value, canonicalTimestamp } =
  await sdk.solana.verifyDataUpdate(result);
```

Then read the finalized feed:

```ts
const feed = await sdk.solana.readFeed(jobId);
```

### One-call request + submit

```ts
const { result, signature } = await sdk.requestAndSubmit(jobId, {
  apiConfig,
});
```

This is equivalent to:

```ts
const result = await sdk.gateway.requestSignedData({ jobId, apiConfig });
const { signature } = await sdk.solana.submitDataUpdate(result);
```

### Fast requests with a cached context

By default every `requestSignedData` call fetches three slow-changing inputs up
front (in parallel): the on-chain registry version, the node set, and the job
config. When you run many rounds for the same job, fetch these once and reuse
them so each round is a single gateway POST.

```ts
// Fetch registryVersion + nodes + jobConfig once.
const context = await sdk.gateway.prepareContext(jobId);

// Reuse it across rounds — no prelude fetches.
const result = await sdk.gateway.requestSignedData({ jobId, apiConfig, context });
```

`context` is a `Partial<RoundContext>`, so you can cache only what you have
and let `requestSignedData` fetch the rest:

```ts
const result = await sdk.gateway.requestSignedData({
  jobId,
  apiConfig,
  context: { nodes, jobConfig }, // registryVersion still fetched fresh
});
```

Caching is opt-in because these inputs can drift. A stale `registryVersion` (or
node set) yields a result the chain will reject — refresh the context when the
on-chain registry version changes. The same `context` field is accepted by
`requestAndSubmit`.

## Private APIs and encrypted secrets

Jobs can use private APIs without sending plaintext secrets to the gateway.

```ts
const result = await sdk.gateway.requestSignedData({
  jobId,
  apiConfig: {
    url: "https://api.example.com/private-price?key={{secret.apiKey}}",
    responseParser: "$.price",
  },
  encrypt: {
    secrets: {
      apiKey: process.env.API_KEY!,
    },
  },
});
```

Secrets are encrypted into per-node envelopes. The gateway coordinates the round but should not receive plaintext API credentials.

Private API access is still an active security-sensitive surface. Do not treat encrypted secret delivery as production-ready until gateway/node-side test vectors and validation are complete.

## EVM verification

After a gateway round, the same signed result can be verified on EVM chains.

The SDK ships deployed testnet verifier addresses and framework-agnostic tuple builders. It does not depend on ethers or viem at runtime.

### Deployed verifier address

The verifier is deployed with CREATE2 so the contract address is the same on every
supported EVM chain.

```ts
import { MOLPHA_VERIFIER_ADDRESS } from "@molpha-oracle/sdk";

const address = MOLPHA_VERIFIER_ADDRESS;
```

### Build verifier arguments

```ts
import { buildEvmVerifierArgs } from "@molpha-oracle/sdk";

const result = await sdk.gateway.requestSignedData({ jobId, apiConfig });

const { dataUpdate, signature } = buildEvmVerifierArgs(result);
```

The generated tuples match the Molpha EVM verifier ABI:

```ts
// dataUpdate:
// [bytes32 jobId,
//  uint32 registryVersion,
//  uint32 signaturesRequired,
//  bytes32 valuePacked,
//  uint64 timestamp]

// signature:
// [bytes32 s,
//  address commitment,
//  uint256 signersBitmap]
```

### ethers

```ts
import { Contract } from "ethers";
import {
  buildEvmVerifierArgs,
  MOLPHA_VERIFIER_ADDRESS,
} from "@molpha-oracle/sdk";

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
  MOLPHA_VERIFIER_ADDRESS,
} from "@molpha-oracle/sdk";

const client = createPublicClient({
  chain,
  transport: http(),
});

const { dataUpdate, signature } = buildEvmVerifierArgs(result);

await client.readContract({
  address: MOLPHA_VERIFIER_ADDRESS,
  abi,
  functionName: "verify",
  args: [dataUpdate, signature],
});
```

Lower-level helpers are also exported for manual integrations:

```ts
import {
  toFixedHex,
  signersBitmapToUint256,
  signersBitmapToDecimal,
} from "@molpha-oracle/sdk";
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
} from "@molpha-oracle/sdk";

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
import { buildStarknetVerifierArgs } from "@molpha-oracle/sdk";

const result = await sdk.gateway.requestSignedData({ jobId, apiConfig });

const { dataUpdate, signature } = buildStarknetVerifierArgs(result);
```

The generated objects match the Molpha Starknet verifier interface:

```ts
// dataUpdate:
// {
//   job_id: u256,
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
} from "@molpha-oracle/sdk";
```

## What verification checks

A Molpha data update is valid only if the verifier can confirm:

- the update targets the expected `jobId`;
- the result was signed against a specific `registryVersion`;
- the quorum satisfies `signaturesRequired`;
- the signer bitmap maps to valid selected nodes;
- the aggregate Schnorr signature is valid;
- the signed value and canonical timestamp match the message;
- the timestamp is within the accepted freshness bounds;
- on Solana verification paths, the job’s API config hash matches the committed job configuration.

Solana verification finalizes feed state. EVM and Starknet verification are stateless and return whether the signed Molpha update is valid for the deployed verifier registry.

## IDL vendoring

The Solana client needs the Anchor IDL for the Molpha program.

A vendored copy ships under `idl/` and is used by default:

```ts
import { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "@molpha-oracle/sdk";
```

Override `idl` and `programId` when targeting another deployment.

Keep the vendored IDL aligned with the deployed program. Mismatched IDL/program versions can produce invalid account derivations, decoding errors, or failed instruction simulation.

## Standalone clients

`MolphaSDK` is a convenience facade.

You can also use the lower-level clients directly:

```ts
import {
  MolphaSolanaClient,
  MolphaGateway,
} from "@molpha-oracle/sdk";

const solana = MolphaSolanaClient.create({
  connection,
  wallet,
});

const gateway = new MolphaGateway(
  endpoints,
  () => solana.getRegistryVersion(),
);
```

The facade wires the registry version resolver automatically.

## Status

`0.1.0` — first public SDK iteration.

Current scope:

- Solana subscription flow;
- Solana job creation;
- gateway signed-data requests;
- Solana data update verification/submission;
- EVM verifier argument building;
- Starknet verifier argument building;
- deployed testnet verifier address helpers.

Known limitations:

- private API envelope encryption still needs gateway/node-side test-vector validation;
- verifier-node registration and admin tooling are intentionally outside this package;
- production deployments should use authenticated gateway requests;
- testnet verifier addresses may change between protocol releases.

Solana paths such as selection bitmap, previous-version remap, and `verify_data_update` decoding are aligned with the Molpha program version vendored in this repo.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
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
   npm install @molpha-oracle/sdk
   ```

3. Prereleases from `dev`

   Pushes to `dev` publish a snapshot version on the `dev` dist-tag, for example:

   ```text
   0.2.0-dev-<timestamp>
   ```

   Install with:

   ```bash
   npm install @molpha-oracle/sdk@dev
   ```

   Requires at least one pending changeset.

### One-time setup

1. Add `NPM_TOKEN` under GitHub repo settings:

   ```text
   Settings → Secrets and variables → Actions
   ```

   Use a granular npm automation token with publish access to the `@molpha-oracle` scope.

2. Publish a stable release from `main` first.

   npm assigns the first published version to the `latest` tag regardless of `--tag`. If a `dev` snapshot is published before any stable release, that prerelease can become `latest`.

   The `dev` workflow should guard against this and fail until a stable `latest` exists.

If `latest` ever points to a prerelease, repoint it after publishing a stable version:

```bash
npm dist-tag add @molpha-oracle/sdk@<stable-version> latest
```
