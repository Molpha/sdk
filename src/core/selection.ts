/**
 * Node selection: deterministic, verifiable, without replacement.
 *
 * ⚠️ TODO(verify-against-program): `deriveGroupBitmap` is a faithful best-effort
 * port of the on-chain `derive_group_bitmap`. The program is the source of truth.
 * The exact per-candidate extraction (chunk width, round-counter encoding, modulo
 * vs. rejection) and the `effectiveSelectionSize` clamp MUST be byte-matched
 * against `molpha-solana-program` before publish — a mismatch makes every
 * signature fail `InvalidSelectionBitmap` on-chain.
 *
 * Canonical bitmap representation = 32-byte big-endian word (bit `i` lives in
 * byte `31 - (i >> 3)`, mask `1 << (i & 7)`), matching the wire / on-chain form.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, ensureLength, u32be, u64be, utf8 } from "./encoding.js";

const SELECTION_SEED_DOMAIN = keccak_256(utf8("MOLPHA_SELECTION_V1"));
const SELECTION_DERIVE_DOMAIN = keccak_256(utf8("MOLPHA_SELECTION_DERIVE"));

/** Maximum hashing rounds before giving up (matches on-chain cap). */
const MAX_ROUNDS = 65_536;

const BITMAP_BYTES = 32;
const MAX_NODES = BITMAP_BYTES * 8; // 256

/**
 * `seed = keccak256(keccak256("MOLPHA_SELECTION_V1") || jobId || be32(rv) || be64(ts))`.
 */
export function deriveSelectionSeed(
  jobId: Uint8Array,
  registryVersion: number,
  canonicalTimestamp: number | bigint,
): Uint8Array {
  ensureLength(jobId, 32, "jobId");
  return keccak_256(
    concatBytes(
      SELECTION_SEED_DOMAIN,
      jobId,
      u32be(registryVersion),
      u64be(canonicalTimestamp),
    ),
  );
}

/** `min(signaturesRequired + redundancyBuffer, nodeCount)`. */
export function effectiveSelectionSize(
  signaturesRequired: number,
  redundancyBuffer: number,
  nodeCount: number,
): number {
  return Math.min(signaturesRequired + redundancyBuffer, nodeCount);
}

/** Is bit `bit` set in the 32-byte big-endian `bitmap`? */
export function bitmapBitSet(bitmap: Uint8Array, bit: number): boolean {
  if (bit < 0 || bit >= MAX_NODES) return false;
  const byte = bitmap[BITMAP_BYTES - 1 - (bit >> 3)] ?? 0;
  return (byte & (1 << (bit & 7))) !== 0;
}

function setBit(bitmap: Uint8Array, bit: number): void {
  const idx = BITMAP_BYTES - 1 - (bit >> 3);
  bitmap[idx] = (bitmap[idx] ?? 0) | (1 << (bit & 7));
}

/** Indices of set bits in `[0, nodeCount)`, ascending. */
export function selectedIndices(bitmap: Uint8Array, nodeCount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    if (bitmapBitSet(bitmap, i)) out.push(i);
  }
  return out;
}

/**
 * Rejection-sample `groupSize` distinct indices out of `nodeCount` from `seed`,
 * returning a 32-byte big-endian bitmap. Uses the complement optimization when
 * `groupSize > nodeCount / 2` (sample the smaller set, then invert).
 */
export function deriveGroupBitmap(
  seed: Uint8Array,
  nodeCount: number,
  groupSize: number,
): Uint8Array {
  if (nodeCount < 0 || nodeCount > MAX_NODES) {
    throw new RangeError(`nodeCount out of range: ${nodeCount}`);
  }
  const size = Math.min(groupSize, nodeCount);
  const bitmap = new Uint8Array(BITMAP_BYTES);
  if (size <= 0 || nodeCount === 0) return bitmap;
  if (size === nodeCount) {
    for (let i = 0; i < nodeCount; i++) setBit(bitmap, i);
    return bitmap;
  }

  // Complement optimization: sample the smaller half, invert at the end.
  const complement = size > nodeCount - size;
  const sampleCount = complement ? nodeCount - size : size;

  const chosen = new Set<number>();
  let round = 0;
  while (chosen.size < sampleCount && round < MAX_ROUNDS) {
    const block = keccak_256(concatBytes(SELECTION_DERIVE_DOMAIN, seed, u32be(round)));
    for (let off = 0; off + 4 <= block.length && chosen.size < sampleCount; off += 4) {
      const candidate =
        ((block[off]! << 24) |
          (block[off + 1]! << 16) |
          (block[off + 2]! << 8) |
          block[off + 3]!) >>>
        0;
      const idx = candidate % nodeCount;
      chosen.add(idx);
    }
    round++;
  }
  if (chosen.size < sampleCount) {
    throw new Error("GroupBitmapDerivationFailed: round cap reached");
  }

  if (complement) {
    for (let i = 0; i < nodeCount; i++) {
      if (!chosen.has(i)) setBit(bitmap, i);
    }
  } else {
    for (const i of chosen) setBit(bitmap, i);
  }
  return bitmap;
}

/**
 * Convenience orchestrator: derive the selection bitmap end-to-end.
 * `redundancy` defaults to 0; `ts` defaults to the current unix second.
 */
export function deriveSelectionBitmap(
  jobId: Uint8Array,
  registryVersion: number,
  nodeCount: number,
  signaturesRequired: number,
  redundancy = 0,
  ts: number | bigint = Math.floor(Date.now() / 1000),
): Uint8Array {
  const seed = deriveSelectionSeed(jobId, registryVersion, ts);
  const size = effectiveSelectionSize(signaturesRequired, redundancy, nodeCount);
  return deriveGroupBitmap(seed, nodeCount, size);
}
