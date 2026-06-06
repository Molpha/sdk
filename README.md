# @molpha-oracle/sdk

Browser-first TypeScript SDK for **Molpha data consumers / job owners**: subscribe, create a job,
run a gateway round, submit the signed result on-chain, and read it back. Node registration and
admin tooling live in the program repo CLI and are **not** included here.

## Install

```bash
pnpm add @molpha-oracle/sdk
# Solana surface is optional — only needed for `MolphaSDK` / `MolphaSolanaClient`:
pnpm add @solana/web3.js @coral-xyz/anchor @solana/spl-token
```

| Import | Use |
|---|---|
| `@molpha-oracle/sdk` | Facade (`MolphaSDK`), `MolphaGateway`, `MolphaSolanaClient`, `core`. Browser-safe (no `fs` in the main entry). |
| `@molpha-oracle/sdk/utils` | `walletFromKeypairFile` — load a Solana CLI keypair as an Anchor `Wallet` (Node.js only). |

`"sideEffects": false` and ESM let gateway-only or read-only apps tree-shake the Anchor-heavy
Solana code when they do not import it.

## Quick start

```ts
import { Connection } from "@solana/web3.js";
import { MolphaSDK } from "@molpha-oracle/sdk";
import { walletFromKeypairFile } from "@molpha-oracle/sdk/utils";

const sdk = new MolphaSDK({
  connection: new Connection("https://api.devnet.solana.com", "confirmed"),
  wallet: walletFromKeypairFile("~/.config/solana/id.json"),
});

const { result, signature } = await sdk.executeAndSubmit(jobId, {
  apiConfig: { url: "https://api.example.com/price", responseParser: "$.price" },
});
```

`executeAndSubmit` runs a gateway round against the current on-chain registry version and submits
the feed update in one call.

## Configuration

### Required

| Option | Description |
|---|---|
| `connection` | Solana RPC `Connection`. |
| `wallet` | [`MolphaWallet`](#wallet) — signs on-chain transactions and gateway auth (when possible). |

### Optional (sensible defaults)

| Option | Default |
|---|---|
| `endpoints` | `DEFAULT_GATEWAY_ENDPOINT` (`http://188.166.222.245:8080`) — string or array for failover |
| `programId` | `MOLPHA_PROGRAM_ADDRESS` from the vendored IDL |
| `idl` | `MOLPHA_IDL` (vendored `idl/molpha.json`) |
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

`wallet` is a single `MolphaWallet`: Anchor’s `Wallet` (Solana txs) plus gateway
auth for `execute` / `executeAndSubmit`.

| Layer | What it signs |
|---|---|
| On-chain (`MolphaSolanaClient`) | Solana transactions (`subscribe`, `createJob`, `submitDataUpdate`, …) |
| Gateway (`MolphaGateway`) | `authMessage(jobId, timestamp)` — ed25519 over a keccak digest |

Gateway auth is resolved automatically:

1. `wallet.signAuthMessage` if set (typical for browser adapters).
2. Else from Anchor `Wallet.payer` when the secret key is available (`walletFromKeypairFile`, Node `Wallet`).
3. Else omitted → all-zero `authSig` (dev only; production jobs should always authenticate).

### Utils (Node.js)

```ts
import { walletFromKeypairFile } from "@molpha-oracle/sdk/utils";

const wallet = walletFromKeypairFile("~/.config/solana/id.json");
```

### Browser

```ts
import type { MolphaWallet } from "@molpha-oracle/sdk";

const wallet: MolphaWallet = {
  publicKey: adapter.publicKey,
  signTransaction: (tx) => adapter.signTransaction(tx),
  signAllTransactions: (txs) => adapter.signAllTransactions(txs),
  signAuthMessage: async (msg) => new Uint8Array(await adapter.signMessage(msg)),
};
```

Per-call gateway auth override: `gateway.execute({ ..., signer })` or `executeAndSubmit` with the
same field in its options object.

## Usage

End-to-end flow via `MolphaSDK` (`sdk.solana` + `sdk.gateway`). Use
`MolphaSolanaClient` / `MolphaGateway` standalone when you only need one side.

```ts
import { Connection } from "@solana/web3.js";
import { MolphaSDK, PlanType, deriveApiConfigHash } from "@molpha-oracle/sdk";
import { walletFromKeypairFile } from "@molpha-oracle/sdk/utils";

const sdk = new MolphaSDK({
  connection: new Connection("https://api.devnet.solana.com", "confirmed"),
  wallet: walletFromKeypairFile("~/.config/solana/id.json"),
});

// 1. Subscribe to a plan — this debits USDC, so confirm the price first.
const plan = await sdk.solana.getPlan(PlanType.Basic);
// Show `plan.subscriptionPrice` (USDC base units) to the user, then confirm:
const { pricePaid } = await sdk.solana.subscribe(PlanType.Basic, {
  maxPriceUsdc: plan.subscriptionPrice, // most you agree to pay; aborts if the live price is higher
});

// 2. Create a job on-chain
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

// 3. Run a gateway round (always uses the current on-chain registry version)
const result = await sdk.gateway.execute({
  jobId,
  apiConfig,
  encrypt: { secrets: { apiKey: process.env.API_KEY! } }, // optional — {{secret.apiKey}} stays off-gateway
});

// 4. Submit on-chain (or simulate first with verifyDataUpdate)
const { signature } = await sdk.solana.submitDataUpdate(result);
// const { value, canonicalTimestamp } = await sdk.solana.verifyDataUpdate(result); // simulate-only

const feed = await sdk.solana.readFeed(jobId);
```

Steps 3–4 in one call: `sdk.executeAndSubmit(jobId, { apiConfig, ... })` (see [Quick start](#quick-start)).

`MolphaSolanaClient.create({ connection, wallet })` and
`new MolphaGateway(endpoints?, () => solana.getRegistryVersion())` share the same defaults as
`MolphaSDK` (the facade wires the registry version resolver for you).

## IDL vendoring

The on-chain client needs the program Anchor IDL (`target/idl/molpha.json` in the program repo).
A copy ships under `idl/` and is the default. Override `idl` and `programId` when targeting another
deployment; keep the vendored file aligned with the program you ship against.

## Status

`0.1.0` — first iteration. Solana paths (selection bitmap, previous-version remap,
`verify_data_update` decode) are aligned with the `molpha` program in this repo. Gateway envelope
encryption still needs gateway/node-side vector validation before production rollout.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Releasing

Versioning and publishing are automated with [changesets](https://github.com/changesets/changesets).
Versions follow [semver](https://semver.org) and are driven by the **nature of each change**, not the
branch it merges from.

### Workflow

1. With your change, add a changeset describing the bump:

   ```bash
   pnpm changeset
   ```

   Choose `patch` (fix), `minor` (feature), or `major` (breaking). Note: changesets applies the
   bump literally — a `major` changeset on `0.x` jumps straight to `1.0.0`. While the package is
   pre-`1.0.0`, pick `minor` for breaking changes and `patch` for features/fixes, and only select
   `major` when you intend to cut `1.0.0`.

2. **Stable releases (`main`):** when changes land on `main`, the `Release` workflow opens a
   "release" PR that bumps `package.json` and updates `CHANGELOG.md`. Merging that PR publishes
   to npm on the `latest` tag.

   ```bash
   npm install @molpha-oracle/sdk
   ```

3. **Prereleases (`dev`):** pushes to `dev` publish a snapshot (e.g. `0.2.0-dev-<timestamp>`) on the
   `dev` dist-tag, for early testing. Requires at least one pending changeset.

   ```bash
   npm install @molpha-oracle/sdk@dev
   ```

### One-time setup

1. Add an automation `NPM_TOKEN` (a granular/automation npm token with publish access to the
   `@molpha-oracle` scope) under **Settings → Secrets and variables → Actions** in the GitHub repo.
   The built-in `GITHUB_TOKEN` handles opening the release PR.
2. **Publish a stable release from `main` first.** npm assigns the first published version to the
   `latest` tag no matter the `--tag`, so if a `dev` snapshot is published before any stable release,
   that prerelease becomes `latest`. The `dev` workflow guards against this and will fail until a
   stable `latest` exists.

If `latest` ever ends up on a prerelease, repoint it after a stable version is published:

```bash
npm dist-tag add @molpha-oracle/sdk@<stable-version> latest
```
