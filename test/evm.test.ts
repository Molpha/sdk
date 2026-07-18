import { describe, expect, it } from "vitest";
import type { DataUpdateResult } from "../src/core/types.js";
import {
  MOLPHA_VERIFIER_ADDRESSES,
  MOLPHA_VERIFIER_ARBITRUM_SEPOLIA,
  MOLPHA_VERIFIER_AVALANCHE_FUJI,
  MOLPHA_VERIFIER_BSC_TESTNET,
  MOLPHA_VERIFIER_EVM_SEPOLIA,
  getMolphaVerifierAddress,
} from "../src/evm/constants.js";
import {
  buildEvmVerifierArgs,
  signersBitmapToDecimal,
  signersBitmapToUint256,
  toFixedHex,
} from "../src/evm/helpers.js";

const SAMPLE_RESULT: DataUpdateResult = {
  feedId: "aa".repeat(32),
  value: "100",
  valuePacked: "bb".repeat(32),
  timestamp: 1_700_000_000,
  registryVersion: 2,
  signaturesRequired: 3,
  signersBitmap: "00".repeat(31) + "01",
  s: "cc".repeat(32),
  commitmentAddr: "dd".repeat(20),
  fresh: true,
};

describe("MOLPHA verifier addresses", () => {
  it("exports the expected deployed addresses", () => {
    expect(MOLPHA_VERIFIER_EVM_SEPOLIA).toBe(
      "0xb8e31ec095A22B1374cF87C19F94889476AFeB74",
    );
    expect(MOLPHA_VERIFIER_ARBITRUM_SEPOLIA).toBe(
      "0x61f8e4C4c7272332D5fc45586b6641A586127D07",
    );
    expect(MOLPHA_VERIFIER_AVALANCHE_FUJI).toBe(
      "0x09F3E1eBCB296876882a3A4C2CE4D18Ea27582fC",
    );
    expect(MOLPHA_VERIFIER_BSC_TESTNET).toBe(
      "0x04Ba82685B6c805C0f3b5C9e6CFc9c7439b56F26",
    );
  });

  it("maps network ids to addresses", () => {
    expect(MOLPHA_VERIFIER_ADDRESSES["evm-sepolia"]).toBe(MOLPHA_VERIFIER_EVM_SEPOLIA);
    expect(getMolphaVerifierAddress("bsc-testnet")).toBe(MOLPHA_VERIFIER_BSC_TESTNET);
  });
});

describe("toFixedHex", () => {
  it("normalizes hex with optional 0x prefix and quotes", () => {
    expect(toFixedHex("aa".repeat(20), 20, "commitment")).toBe(`0x${"aa".repeat(20)}`);
    expect(toFixedHex(`0x${"bb".repeat(32)}`, 32, "jobId")).toBe(`0x${"bb".repeat(32)}`);
    expect(toFixedHex(`"${"cc".repeat(32)}"`, 32, "signature")).toBe(`0x${"cc".repeat(32)}`);
  });

  it("throws on wrong byte length", () => {
    expect(() => toFixedHex("abcd", 32, "jobId")).toThrow(/expected 32 bytes/);
  });
});

describe("signersBitmap conversion", () => {
  it("converts a 32-byte bitmap to uint256", () => {
    expect(signersBitmapToUint256("00".repeat(31) + "01")).toBe(1n);
    expect(signersBitmapToDecimal("00".repeat(31) + "01")).toBe("1");
  });
});

describe("buildEvmVerifierArgs", () => {
  it("builds verifier tuples from DataUpdateResult", () => {
    const { dataUpdate, signature } = buildEvmVerifierArgs(SAMPLE_RESULT);

    expect(dataUpdate).toEqual([
      `0x${"aa".repeat(32)}`,
      2,
      3,
      `0x${"bb".repeat(32)}`,
      1_700_000_000,
    ]);

    expect(signature).toEqual([
      `0x${"cc".repeat(32)}`,
      `0x${"dd".repeat(20)}`,
      1n,
    ]);
  });
});
