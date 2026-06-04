import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { DataUpdateResult } from "../src/core/types.js";
import {
  bitmapToIndices,
  decodeVerifyReturn,
  type RegistryStateView,
  resolveRemainingAccounts,
} from "../src/solana/accounts.js";
import { registryIndexPda, VIRTUAL_INDEX } from "../src/solana/pdas.js";

const programId = new PublicKey("MoLFeTRpDZgckPjjbLwW1wB9n85bQiqboPnvw9RwoG8");

/** bits 0,1,2 set in the 32-byte big-endian word. */
const BITMAP_012 = "00".repeat(31) + "07";

const baseResult: DataUpdateResult = {
  jobId: "11".repeat(32),
  value: "1",
  valuePacked: "00".repeat(32),
  timestamp: 1,
  registryVersion: 5,
  signaturesRequired: 1,
  signersBitmap: BITMAP_012,
  s: "00".repeat(32),
  commitmentAddr: "00".repeat(20),
  fresh: true,
};

const baseRegistry: RegistryStateView = {
  currentVersion: 5,
  previousVersion: 4,
  previousExpiresAt: 9_999_999_999n,
  lastTransitionType: { none: {} },
  removedOldIndex: 0xffffffff,
  movedOldIndex: 0xffffffff,
};

const keys = (metas: { pubkey: PublicKey }[]) => metas.map((m) => m.pubkey.toBase58());
const pda = (i: number) => registryIndexPda(i, programId).toBase58();

describe("bitmapToIndices", () => {
  it("reads set bits from a 32-byte big-endian word", () => {
    expect(bitmapToIndices(BITMAP_012)).toEqual([0, 1, 2]);
  });
});

describe("resolveRemainingAccounts", () => {
  it("current version maps index == bit", () => {
    const metas = resolveRemainingAccounts(baseResult, baseRegistry, programId);
    expect(keys(metas)).toEqual([pda(0), pda(1), pda(2)]);
    expect(metas.every((m) => !m.isSigner && !m.isWritable)).toBe(true);
  });

  it("previous version + RemoveTail maps removed index to virtual", () => {
    const result = { ...baseResult, registryVersion: 4 };
    const registry: RegistryStateView = {
      ...baseRegistry,
      lastTransitionType: { removeTail: {} },
      removedOldIndex: 1,
    };
    const metas = resolveRemainingAccounts(result, registry, programId);
    expect(keys(metas)).toEqual([pda(0), pda(VIRTUAL_INDEX), pda(2)]);
  });

  it("previous version + RemoveSwap remaps the moved index to the removed slot", () => {
    const result = { ...baseResult, registryVersion: 4 };
    const registry: RegistryStateView = {
      ...baseRegistry,
      lastTransitionType: { removeSwap: {} },
      removedOldIndex: 1,
      movedOldIndex: 2,
    };
    const metas = resolveRemainingAccounts(result, registry, programId);
    expect(keys(metas)).toEqual([pda(0), pda(VIRTUAL_INDEX), pda(1)]);
  });

  it("previous version + Add keeps identity mapping", () => {
    const result = { ...baseResult, registryVersion: 4 };
    const registry: RegistryStateView = {
      ...baseRegistry,
      lastTransitionType: { add: {} },
      removedOldIndex: 1,
      movedOldIndex: 2,
    };
    const metas = resolveRemainingAccounts(result, registry, programId);
    expect(keys(metas)).toEqual([pda(0), pda(1), pda(2)]);
  });

  it("rejects a version that is neither current nor previous", () => {
    const result = { ...baseResult, registryVersion: 2 };
    expect(() => resolveRemainingAccounts(result, baseRegistry, programId)).toThrow(
      /InvalidRegistryVersion/,
    );
  });
});

describe("decodeVerifyReturn", () => {
  it("decodes value + timestamp from the 72-byte return payload", () => {
    const data = new Uint8Array(72);
    data.set(new Uint8Array(32).fill(0xab), 0);
    const ts = new DataView(data.buffer, 32, 8);
    ts.setBigInt64(0, 1_700_000_123n, false);

    expect(decodeVerifyReturn(data)).toEqual({
      value: "ab".repeat(32),
      canonicalTimestamp: "1700000123",
    });
  });

  it("rejects non-72-byte payloads", () => {
    expect(() => decodeVerifyReturn(new Uint8Array(40))).toThrow(/size mismatch/);
  });
});
