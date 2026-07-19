import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";
import { authMessage } from "../src/gateway/auth.js";

describe("authMessage", () => {
  it("matches gateway RequestAuth hashing (domain + feed_id + uint64_le(timestamp))", () => {
    const feedId = Uint8Array.from({ length: 32 }, (_, i) => i);
    const timestamp = 1_750_000_000;
    const msg = authMessage(feedId, timestamp);

    expect(msg).toHaveLength(32);

    const keypair = ed25519.utils.randomPrivateKey();
    const publicKey = ed25519.getPublicKey(keypair);
    const signature = ed25519.sign(msg, keypair);
    expect(ed25519.verify(signature, msg, publicKey)).toBe(true);
  });
});
