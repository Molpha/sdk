import { keccak_256 } from "@noble/hashes/sha3";
import { describe, expect, it } from "vitest";
import { concatBytes, u32be, u64be, utf8 } from "../src/core/encoding.js";
import {
  bitmapBitSet,
  deriveGroupBitmap,
  deriveSelectionSeed,
  effectiveSelectionSize,
  selectedIndices,
} from "../src/core/selection.js";

const jobId = new Uint8Array(32).fill(7);

describe("deriveSelectionSeed", () => {
  it("matches the documented construction", () => {
    const expected = keccak_256(
      concatBytes(
        keccak_256(utf8("MOLPHA_SELECTION_V1")),
        jobId,
        u32be(3),
        u64be(1_700_000_000),
      ),
    );
    expect(deriveSelectionSeed(jobId, 3, 1_700_000_000)).toEqual(expected);
  });
});

describe("effectiveSelectionSize", () => {
  it("clamps to nodeCount", () => {
    expect(effectiveSelectionSize(3, 2, 100)).toBe(5);
    expect(effectiveSelectionSize(3, 2, 4)).toBe(4);
  });
});

describe("bitmap bit helpers", () => {
  it("round-trips set bits in the 32-byte big-endian word", () => {
    const bitmap = new Uint8Array(32);
    // bit 0 lives in the last byte, lsb.
    bitmap[31] = 0b0000_0101; // bits 0 and 2
    bitmap[30] = 0b0000_0010; // bit 9
    expect(bitmapBitSet(bitmap, 0)).toBe(true);
    expect(bitmapBitSet(bitmap, 1)).toBe(false);
    expect(bitmapBitSet(bitmap, 2)).toBe(true);
    expect(bitmapBitSet(bitmap, 9)).toBe(true);
    expect(selectedIndices(bitmap, 16)).toEqual([0, 2, 9]);
  });
});

describe("deriveGroupBitmap", () => {
  const seed = deriveSelectionSeed(jobId, 1, 1234);

  it("selects exactly groupSize distinct nodes (no replacement)", () => {
    for (const [nodeCount, groupSize] of [
      [10, 3],
      [10, 7], // exercises the complement path
      [50, 25],
      [4, 4],
    ] as const) {
      const bitmap = deriveGroupBitmap(seed, nodeCount, groupSize);
      const idxs = selectedIndices(bitmap, nodeCount);
      expect(idxs.length).toBe(groupSize);
      expect(new Set(idxs).size).toBe(groupSize);
      expect(idxs.every((i) => i >= 0 && i < nodeCount)).toBe(true);
    }
  });

  it("is deterministic", () => {
    expect(deriveGroupBitmap(seed, 20, 8)).toEqual(deriveGroupBitmap(seed, 20, 8));
  });

  it("returns all-zero for empty selection and full for groupSize >= nodeCount", () => {
    expect(selectedIndices(deriveGroupBitmap(seed, 10, 0), 10)).toEqual([]);
    expect(selectedIndices(deriveGroupBitmap(seed, 5, 9), 5)).toEqual([0, 1, 2, 3, 4]);
  });
});
