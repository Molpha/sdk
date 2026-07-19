/**
 * Deployed Molpha verifier contract address on EVM chains.
 * Deployed via CREATE2 for the same address on every supported chain.
 */

/** Supported EVM testnet identifiers (chain selection only). */
export type MolphaEvmNetwork =
  | "evm-sepolia"
  | "arbitrum-sepolia"
  | "avalanche-fuji"
  | "bsc-testnet";

/** CREATE2 Molpha verifier address — identical on all supported EVM chains. */
export const MOLPHA_VERIFIER_ADDRESS =
  "0xE1fd792b7E54e0C8F0Cd1c8055E446ff36d233eB" as const;
