import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "../src/core/encoding.js";
import type { Node } from "../src/core/types.js";
import { encryptForNodes, resolveAPIConfig } from "../src/gateway/encryption.js";

describe("resolveAPIConfig", () => {
  it("substitutes {{secret.*}} placeholders in string fields", () => {
    const resolved = resolveAPIConfig(
      {
        url: "https://api/{{secret.path}}",
        headers: { Authorization: "Bearer {{secret.token}}" },
        responseParser: "$.price",
      },
      { path: "v1/price", token: "abc123" },
    );
    expect(resolved.url).toBe("https://api/v1/price");
    expect(resolved.headers?.Authorization).toBe("Bearer abc123");
  });

  it("throws on a missing secret", () => {
    expect(() =>
      resolveAPIConfig({ url: "{{secret.missing}}", responseParser: "x" }, {}),
    ).toThrow(/Missing secret/);
  });
});

describe("encryptForNodes", () => {
  it("produces one envelope per selected node", () => {
    const node: Node = {
      index: 3,
      peerId: "p",
      address: "a",
      signingKey: bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true)),
    };
    const bundle = encryptForNodes(
      { url: "https://api", responseParser: "$.price" },
      {},
      [node],
    );
    expect(Object.keys(bundle.envelopes)).toEqual(["3"]);
    expect(bundle.ephemeralPub.length).toBeGreaterThan(0);
    expect(bundle.ciphertext.length).toBeGreaterThan(0);
  });
});
