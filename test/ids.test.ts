import { keccak_256 } from "@noble/hashes/sha3";
import { describe, expect, it } from "vitest";
import { concatBytes, utf8 } from "../src/core/encoding.js";
import { deriveJobId } from "../src/core/ids.js";

describe("deriveJobId", () => {
  const owner = new Uint8Array(32).fill(1);
  const apiConfigHash = new Uint8Array(32).fill(2);

  it("matches keccak256(MOLPHA_JOB_V1 || owner || apiConfigHash)", () => {
    const expected = keccak_256(concatBytes(utf8("MOLPHA_JOB_V1"), owner, apiConfigHash));
    expect(deriveJobId(owner, apiConfigHash)).toEqual(expected);
  });

  it("returns 32 bytes and is deterministic", () => {
    const a = deriveJobId(owner, apiConfigHash);
    const b = deriveJobId(owner, apiConfigHash);
    expect(a.length).toBe(32);
    expect(a).toEqual(b);
  });

  it("rejects wrong-length inputs", () => {
    expect(() => deriveJobId(new Uint8Array(31), apiConfigHash)).toThrow();
    expect(() => deriveJobId(owner, new Uint8Array(33))).toThrow();
  });
});
