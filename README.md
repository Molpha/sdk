# @molpha/sdk

Standalone, browser-first TypeScript SDK for **Molpha data consumers / job owners**.
Everything a consumer does end-to-end: subscribe, create a job, run a gateway round, submit the
signed result on-chain, and read it back. Node registration/admin tooling lives in the program
repo CLI and is intentionally **not** here.

## Install

```bash
pnpm add @molpha/sdk
# Solana surface is an optional peer dep — only needed if you use sdk.solana / the facade:
pnpm add @solana/web3.js @coral-xyz/anchor @solana/spl-token
```

The package ships two entry points:

| Import | Use |
|---|---|
| `@molpha/sdk` | Isomorphic facade + `core` + `gateway` + `solana`. Browser-safe (no `Buffer`/`fs` in `core`/`gateway`). |
| `@molpha/sdk/node` | Node-only helpers: keypair-file `Signer` and `Wallet` (`fs` + ed25519). |

`"sideEffects": false` + ESM, so a read- or gateway-only consumer tree-shakes the Anchor-heavy
`solana` surface out of the bundle.

## Usage

### Full lifecycle — `executeAndSubmit`

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { MolphaSDK, MOLPHA_IDL } from "@molpha/sdk";
import { nodeWalletFromFile, keypairFileSigner } from "@molpha/sdk/node";

const sdk = new MolphaSDK({
  endpoints: ["https://gw1.molpha.io", "https://gw2.molpha.io"], // failover order
  connection: new Connection("https://api.devnet.solana.com", "confirmed"),
  wallet: nodeWalletFromFile("~/.config/solana/id.json"),        // or a browser wallet adapter
  programId: new PublicKey("MoLFeTRpDZgckPjjbLwW1wB9n85bQiqboPnvw9RwoG8"),
  idl: MOLPHA_IDL,                                               // vendored; pass any compatible IDL
  signer: keypairFileSigner("~/.config/solana/id.json"),        // ed25519 authSig signer
});

// resolves registryVersion from Solana → runs the round → submits to the feed
const { result, signature } = await sdk.executeAndSubmit(jobId, {
  apiConfig: { url: "https://api.example.com/price", responseParser: "$.price" },
});
```

### Gateway only (no on-chain writes)

```ts
import { MolphaGateway } from "@molpha/sdk";

const gateway = new MolphaGateway(["https://gw1.molpha.io", "https://gw2.molpha.io"]);
const result = await gateway.execute({
  jobId,
  registryVersion: await sdk.solana.getRegistryVersion(),
  apiConfig: { url: "https://api.example.com/price", responseParser: "$.price" },
  encrypt: { secrets: { apiKey: process.env.API_KEY! } }, // {{secret.apiKey}} stays opaque to the gateway
});
```

### Read / subscribe / create / submit / verify

```ts
const feed = await sdk.solana.readFeed(jobId);                  // current on-chain value
await sdk.solana.subscribe(1);                                  // plan 0|1|2|3
await sdk.solana.createJob({ apiConfigHash, signaturesRequired: 3, decimals: 8 });
await sdk.solana.submitDataUpdate(result, { computeUnitLimit: 700_000 });
const { value, canonicalTimestamp } = await sdk.solana.verifyDataUpdate(result); // simulate-only
```

## IDL vendoring

The Solana client needs the program's Anchor IDL (`target/idl/molpha.json`). A copy is vendored
under `idl/` and re-exported as `MOLPHA_IDL`, but the client never hard-imports it — you pass it
via `create({ idl })`. Pin the vendored copy to the deployed program version in your release
process.

## Status

`0.1.0` — first iteration. Signature-critical Solana client paths are now reconciled against the
`molpha` on-chain program in this repo (selection-bitmap derivation, previous-version remap, and
`verify_data_update` return-data decode). Gateway envelope encryption still requires
gateway/node-side vector validation before production rollout.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```
