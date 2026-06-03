/**
 * `@molpha/sdk/node` — Node-only conveniences (fs + ed25519). Kept out of `core`
 * and `gateway` so browser bundles never pull in `fs`.
 */
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { Wallet } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import type { Signer } from "./core/types.js";

/** Load a Solana CLI keypair JSON file (array of 64 bytes) into a `Keypair`. */
export function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** Anchor-compatible `Wallet` backed by a keypair file. */
export function nodeWalletFromFile(path: string): Wallet {
  return new Wallet(loadKeypair(path));
}

/** A gateway `Signer` that ed25519-signs with the keypair's seed. */
export function keypairFileSigner(path: string): Signer {
  const secret = loadKeypair(path).secretKey; // 64 bytes: seed(32) || pub(32)
  const seed = secret.slice(0, 32);
  return async (message: Uint8Array): Promise<Uint8Array> => ed25519.sign(message, seed);
}

export { Wallet };
