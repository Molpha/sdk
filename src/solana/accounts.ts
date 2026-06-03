/**
 * Account fetching, registry-version transition resolution, remaining-accounts
 * construction, and verify-return decoding.
 *
 * ⚠️ TODO(verify-against-program): the previous-version transition remap and the
 * `verify_data_update` return layout are ported from the spec prose; reconcile
 * with `molpha-solana-program`.
 */
import { type AccountMeta, PublicKey } from "@solana/web3.js";
import { bytesToHex, hexToBytes } from "../core/encoding.js";
import { selectedIndices } from "../core/selection.js";
import type { DataUpdateResult } from "../core/types.js";
import { registryIndexPda, VIRTUAL_INDEX } from "./pdas.js";

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
    const isRemoveSwap = "removeSwap" in registry.lastTransitionType;
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
 * value + timestamp. ⚠️ TODO(verify-against-program): spec says 72 bytes but the
 * documented payload is value(32) + i64 BE (40 bytes); we read those leading
 * fields and ignore any trailing bytes.
 */
export function decodeVerifyReturn(data: Uint8Array): {
  value: string;
  canonicalTimestamp: string;
} {
  if (data.length < 40) {
    throw new Error(`verify return too short: ${data.length} bytes`);
  }
  const value = bytesToHex(data.slice(0, 32));
  const view = new DataView(data.buffer, data.byteOffset + 32, 8);
  const canonicalTimestamp = view.getBigInt64(0, false); // i64 big-endian
  return { value, canonicalTimestamp: canonicalTimestamp.toString() };
}
