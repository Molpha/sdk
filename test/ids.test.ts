import { keccak_256 } from "@noble/hashes/sha3";
import { describe, expect, it } from "vitest";
import { bytesToHex, concatBytes, utf8 } from "../src/core/encoding.js";
import { deriveFeedId, deriveFeedIdString } from "../src/core/ids.js";

describe("deriveFeedId", () => {
  const owner = new Uint8Array(32).fill(1);
  const apiConfigHash = new Uint8Array(32).fill(2);
  const signaturesRequired = 3;

  it("matches keccak256(MOLPHA_JOB_V1 || owner || apiConfigHash || [signaturesRequired])", () => {
    const expected = keccak_256(
      concatBytes(
        utf8("MOLPHA_JOB_V1"),
        owner,
        apiConfigHash,
        Uint8Array.of(signaturesRequired),
      ),
    );
    expect(deriveFeedId(owner, apiConfigHash, signaturesRequired)).toEqual(expected);
  });

  it("returns 32 bytes and is deterministic", () => {
    const a = deriveFeedId(owner, apiConfigHash, signaturesRequired);
    const b = deriveFeedId(owner, apiConfigHash, signaturesRequired);
    expect(a.length).toBe(32);
    expect(a).toEqual(b);
  });

  it("rejects wrong-length inputs", () => {
    expect(() => deriveFeedId(new Uint8Array(31), apiConfigHash, signaturesRequired)).toThrow();
    expect(() => deriveFeedId(owner, new Uint8Array(33), signaturesRequired)).toThrow();
  });

  it("rejects invalid signaturesRequired", () => {
    expect(() => deriveFeedId(owner, apiConfigHash, -1)).toThrow();
    expect(() => deriveFeedId(owner, apiConfigHash, 256)).toThrow();
  });
});

describe("deriveFeedIdString", () => {
  const owner = new Uint8Array(32).fill(1);
  const apiConfigHash = new Uint8Array(32).fill(2);

  it("returns hex encoding of deriveFeedId", () => {
    expect(deriveFeedIdString(owner, apiConfigHash, 1)).toEqual(
      bytesToHex(deriveFeedId(owner, apiConfigHash, 1)),
    );
  });

  it("returns 64-char hex string and is deterministic", () => {
    const a = deriveFeedIdString(owner, apiConfigHash, 5);
    const b = deriveFeedIdString(owner, apiConfigHash, 5);
    expect(a.length).toBe(64);
    expect(a).toEqual(b);
  });
});
