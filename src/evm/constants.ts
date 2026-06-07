/**
 * Deployed Molpha verifier contract addresses on EVM testnets.
 */

/** Supported EVM testnet identifiers. */
export type MolphaEvmNetwork =
  | "evm-sepolia"
  | "arbitrum-sepolia"
  | "avalanche-fuji"
  | "bsc-testnet";

/** Deployed verifier address on Ethereum Sepolia. */
export const MOLPHA_VERIFIER_EVM_SEPOLIA =
  "0xb8e31ec095A22B1374cF87C19F94889476AFeB74" as const;

/** Deployed verifier address on Arbitrum Sepolia. */
export const MOLPHA_VERIFIER_ARBITRUM_SEPOLIA =
  "0x61f8e4C4c7272332D5fc45586b6641A586127D07" as const;

/** Deployed verifier address on Avalanche Fuji. */
export const MOLPHA_VERIFIER_AVALANCHE_FUJI =
  "0x09F3E1eBCB296876882a3A4C2CE4D18Ea27582fC" as const;

/** Deployed verifier address on BSC testnet. */
export const MOLPHA_VERIFIER_BSC_TESTNET =
  "0x04Ba82685B6c805C0f3b5C9e6CFc9c7439b56F26" as const;

/** Network id → deployed verifier address. */
export const MOLPHA_VERIFIER_ADDRESSES: Record<MolphaEvmNetwork, `0x${string}`> = {
  "evm-sepolia": MOLPHA_VERIFIER_EVM_SEPOLIA,
  "arbitrum-sepolia": MOLPHA_VERIFIER_ARBITRUM_SEPOLIA,
  "avalanche-fuji": MOLPHA_VERIFIER_AVALANCHE_FUJI,
  "bsc-testnet": MOLPHA_VERIFIER_BSC_TESTNET,
};

/** Resolve the deployed verifier address for a supported network. */
export function getMolphaVerifierAddress(network: MolphaEvmNetwork): `0x${string}` {
  return MOLPHA_VERIFIER_ADDRESSES[network];
}
