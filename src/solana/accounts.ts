/**
 * Account fetching, registry-version transition resolution, and remaining-accounts
 * construction.
 */
import { type AccountMeta, PublicKey } from "@solana/web3.js";
import { hexToBytes } from "../core/encoding.js";
import { selectedIndices } from "../core/selection.js";
import type { DataUpdateResult } from "../core/types.js";
import { nodePda, VIRTUAL_INDEX } from "./pdas.js";

/** The subset of on-chain `RegistryState` the client needs (Anchor camelCase). */
export interface RegistryStateView {
  currentVersion: number;
  previousVersion: number;
  previousExpiresAt: bigint;
  lastTransitionType:
    | { none: Record<string, never> }
    | { add: Record<string, never> }
    | { removeTail: Record<string, never> }
    | { removeSwap: Record<string, never> };
  removedOldIndex: number;
  movedOldIndex: number;
}

/** Set-bit indices of a 32-byte big-endian bitmap (full 256-bit scan). */
export function bitmapToIndices(signersBitmapHex: string): number[] {
  return selectedIndices(hexToBytes(signersBitmapHex), 256);
}

/**
 * Build the registry-index remaining accounts for a submit. Valid only
 * against the current or previous registry version (else thrown client-side).
 */
export function resolveRemainingAccounts(
  result: DataUpdateResult,
  registry: RegistryStateView,
  programId: PublicKey,
): AccountMeta[] {
  const bits = bitmapToIndices(result.signersBitmap);

  const mapIndex = registryIndexMapper(result.registryVersion, registry);
  return bits.map((bit) => ({
    pubkey: nodePda(mapIndex(bit), programId),
    isSigner: false,
    isWritable: false,
  }));
}

/** Map a selected node index to its registry-index PDA index for a registry version. */
export function resolveRegistryIndexForVersion(
  index: number,
  registryVersion: number,
  registry: RegistryStateView,
): number {
  return registryIndexMapper(registryVersion, registry)(index);
}

function registryIndexMapper(
  registryVersion: number,
  registry: RegistryStateView,
): (bit: number) => number {
  if (registryVersion === registry.currentVersion) {
    return (bit) => bit; // current version: index == bit
  }
  if (registryVersion === registry.previousVersion) {
    if ("add" in registry.lastTransitionType) {
      return (bit) => bit;
    }
    const isRemoveTail = "removeTail" in registry.lastTransitionType;
    const isRemoveSwap = "removeSwap" in registry.lastTransitionType;
    if (!isRemoveTail && !isRemoveSwap) {
      throw new Error(
        "InvalidTransitionAccount: previous-version verification requires remove-transition metadata",
      );
    }
    return (bit) => {
      if (bit === registry.removedOldIndex) return VIRTUAL_INDEX;
      if (isRemoveSwap && bit === registry.movedOldIndex) return registry.removedOldIndex;
      return bit;
    };
  }
  throw new Error(
    `InvalidRegistryVersion: ${registryVersion} is neither current (${registry.currentVersion}) nor previous (${registry.previousVersion})`,
  );
}
