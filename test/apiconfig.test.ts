import { describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  canonicalizeAPIConfig,
  deriveApiConfigHash,
} from "../src/core/apiconfig.js";
import { bytesToHex, utf8 } from "../src/core/encoding.js";

describe("canonicalizeAPIConfig", () => {
  it("fills gateway defaults for omitted optional fields", () => {
    expect(
      canonicalizeAPIConfig({
        url: "https://api.example.com/price",
        responseParser: "$.price",
      }),
    ).toEqual({
      url: "https://api.example.com/price",
      method: "GET",
      headers: {},
      responseParser: "$.price",
      valueTransform: "multiply:1e6",
    });
  });
});

describe("deriveApiConfigHash", () => {
  const minimal = {
    url: "https://api.example.com/price",
    responseParser: "$.price",
  };

  it("is keccak256(JSON.stringify(canonical apiConfig))", () => {
    const canonicalJson = JSON.stringify(canonicalizeAPIConfig(minimal));
    expect(deriveApiConfigHash(minimal)).toEqual(keccak_256(utf8(canonicalJson)));
  });

  it("matches node test vector", () => {
    expect(bytesToHex(deriveApiConfigHash(minimal))).toBe(
      "49919e2078d1021a3a792993bdd3a332a1fa0d6c548a327ac7bc8e3c2b61002a",
    );
  });

  it("matches explicit defaults", () => {
    const explicit = {
      url: "https://api.example.com/price",
      method: "GET" as const,
      headers: {},
      responseParser: "$.price",
      valueTransform: "multiply:1e6",
    };
    expect(deriveApiConfigHash(minimal)).toEqual(deriveApiConfigHash(explicit));
  });

  it("is stable and sensitive to config changes", () => {
    const a = deriveApiConfigHash(minimal);
    const b = deriveApiConfigHash(minimal);
    const c = deriveApiConfigHash({
      ...minimal,
      url: "https://api.example.com/other",
    });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBe(32);
  });

  it("hashes placeholder templates, not resolved secrets", () => {
    const withSecret = deriveApiConfigHash({
      url: "https://api.example.com/price",
      headers: { Authorization: "Bearer {{secret.apiKey}}" },
      responseParser: "$.price",
    });
    const withoutSecret = deriveApiConfigHash({
      url: "https://api.example.com/price",
      responseParser: "$.price",
    });
    expect(withSecret).not.toEqual(withoutSecret);
    expect(bytesToHex(withSecret)).toMatch(/^[0-9a-f]{64}$/);
  });
});
