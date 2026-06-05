/**
 * `@molpha-oracle/sdk/utils` — Node.js-only helpers (fs + keypair files). Kept out of the main
 * entry so browser bundles never pull in `fs`.
 */
import { readFileSync } from "node:fs";
import { Wallet } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import type { Signer } from "./core/types.js";
import { signerFromKeypair, type MolphaWallet } from "./wallet.js";

/** Load a Solana CLI keypair JSON file (array of 64 bytes) into a `Keypair`. */
export function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** Anchor `Wallet` backed by a keypair file (gateway auth derived from the same key). */
export function walletFromKeypairFile(path: string): MolphaWallet {
  return new Wallet(loadKeypair(path));
}

/** @deprecated Use `walletFromKeypairFile`. */
export const nodeWalletFromFile = walletFromKeypairFile;

/** @deprecated Use `walletFromKeypairFile` — gateway auth is derived from the same keypair. */
export function keypairFileSigner(path: string): Signer {
  return signerFromKeypair(loadKeypair(path));
}

export { Wallet };
export type { MolphaWallet };
