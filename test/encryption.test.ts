import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "../src/core/encoding.js";
import {
  normalizeSecp256k1PublicKeyHex,
  secp256k1PublicKeyFromCoordinates,
} from "../src/core/nodeKeys.js";
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
      signingKey: bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)),
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

  it("rejects duplicate selected node indexes before resolving secrets", () => {
    const signingKey = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true),
    );
    const duplicateIndexNodes: Node[] = [
      { index: 3, peerId: "p1", address: "a1", signingKey },
      {
        index: 3,
        peerId: "p2",
        address: "a2",
        signingKey: bytesToHex(
          secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true),
        ),
      },
    ];

    expect(() =>
      encryptForNodes(
        { url: "{{secret.missing}}", responseParser: "$.price" },
        {},
        duplicateIndexNodes,
      ),
    ).toThrow(/Duplicate selected node index/);
  });

  it("rejects duplicate selected node public keys", () => {
    const signingKey = bytesToHex(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true),
    );
    const duplicateKeyNodes: Node[] = [
      { index: 3, peerId: "p1", address: "a1", signingKey },
      { index: 4, peerId: "p2", address: "a2", signingKey },
    ];

    expect(() =>
      encryptForNodes(
        { url: "https://api", responseParser: "$.price" },
        {},
        duplicateKeyNodes,
      ),
    ).toThrow(/Duplicate selected node signingKey/);
  });
});

describe("secp256k1 node key helpers", () => {
  it("normalizes compressed and uncompressed public keys to the same compressed hex", () => {
    const privateKey = secp256k1.utils.randomSecretKey();
    const compressed = bytesToHex(secp256k1.getPublicKey(privateKey, true));
    const uncompressed = bytesToHex(secp256k1.getPublicKey(privateKey, false));

    expect(normalizeSecp256k1PublicKeyHex(uncompressed)).toBe(compressed);
    expect(normalizeSecp256k1PublicKeyHex(compressed)).toBe(compressed);
  });

  it("reconstructs and validates a public key from registry X/Y coordinates", () => {
    const privateKey = secp256k1.utils.randomSecretKey();
    const compressed = bytesToHex(secp256k1.getPublicKey(privateKey, true));
    const uncompressed = secp256k1.getPublicKey(privateKey, false);

    expect(
      secp256k1PublicKeyFromCoordinates(
        hexToBytes(bytesToHex(uncompressed.slice(1, 33))),
        hexToBytes(bytesToHex(uncompressed.slice(33, 65))),
      ),
    ).toBe(compressed);
  });

  it("rejects invalid public keys", () => {
    expect(() => normalizeSecp256k1PublicKeyHex("02".padEnd(66, "0"))).toThrow(
      /invalid secp256k1 public key/,
    );
  });
});
