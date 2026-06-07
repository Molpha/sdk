/**
 * Deployed Molpha verifier contract addresses on Starknet testnets.
 */

/** Supported Starknet testnet identifiers. */
export type MolphaStarknetNetwork = "starknet-sepolia";

/** Deployed verifier address on Starknet Sepolia. */
export const MOLPHA_VERIFIER_STARKNET_SEPOLIA =
  "0x0489ddba93d59dbd6ea6aed84bd0697a45af7d23b278262ad78faa6de4ad6af0" as const;

/** Network id -> deployed verifier address. */
export const MOLPHA_VERIFIER_STARKNET_ADDRESSES: Record<
  MolphaStarknetNetwork,
  `0x${string}`
> = {
  "starknet-sepolia": MOLPHA_VERIFIER_STARKNET_SEPOLIA,
};

/** Resolve the deployed verifier address for a supported Starknet network. */
export function getMolphaStarknetVerifierAddress(
  network: MolphaStarknetNetwork,
): `0x${string}` {
  return MOLPHA_VERIFIER_STARKNET_ADDRESSES[network];
}
