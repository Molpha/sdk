/**
 * Deployed Molpha verifier contract addresses on Starknet testnets.
 */

/** Supported Starknet testnet identifiers. */
export type MolphaStarknetNetwork = "starknet-sepolia";

/** Deployed verifier address on Starknet Sepolia. */
export const MOLPHA_VERIFIER_STARKNET_SEPOLIA =
  "0x0378df4dbecf8f0c7daa801282932f7011c7a5e5773bab9eaf68f5fa5e7530ef" as const;

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
