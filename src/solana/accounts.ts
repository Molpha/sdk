/**
 * Account fetching, registry-version transition resolution, remaining-accounts
 * construction, and verify-return decoding.
 */
import { type AccountMeta, PublicKey } from "@solana/web3.js";
import { bytesToHex, hexToBytes } from "../core/encoding.js";
import { selectedIndices } from "../core/selection.js";
import type { DataUpdateResult } from "../core/types.js";
import { registryIndexPda, VIRTUAL_INDEX } from "./pdas.js";
const VERIFY_RETURN_LEN = 72;

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
 * Build the registry-index remaining accounts for a submit/verify. Valid only
 * against the current or previous registry version (else thrown client-side).
 */
export function resolveRemainingAccounts(
  result: DataUpdateResult,
  registry: RegistryStateView,
  programId: PublicKey,
): AccountMeta[] {
  const bits = bitmapToIndices(result.signersBitmap);

  const mapIndex = mapIndexFn(result.registryVersion, registry);
  return bits.map((bit) => ({
    pubkey: registryIndexPda(mapIndex(bit), programId),
    isSigner: false,
    isWritable: false,
  }));
}

function mapIndexFn(
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

/**
 * Decode the `verify_data_update` simulation return data into the canonical
 * value + timestamp.
 *
 * Program layout is fixed 72 bytes:
 * - `[0..32]` value (bytes32)
 * - `[32..40]` canonical_timestamp (i64, big-endian)
 * - `[40..72]` reserved / zeroed
 */
export function decodeVerifyReturn(data: Uint8Array): {
  value: string;
  canonicalTimestamp: string;
} {
  if (data.length !== VERIFY_RETURN_LEN) {
    throw new Error(
      `verify return size mismatch: expected ${VERIFY_RETURN_LEN}, got ${data.length}`,
    );
  }
  const value = bytesToHex(data.slice(0, 32));
  const view = new DataView(data.buffer, data.byteOffset + 32, 8);
  const canonicalTimestamp = view.getBigInt64(0, false); // i64 big-endian
  return { value, canonicalTimestamp: canonicalTimestamp.toString() };
}
