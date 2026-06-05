import { Wallet } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { authMessage } from "../src/gateway/auth.js";
import { gatewaySignerFromWallet, signerFromKeypair, type MolphaWallet } from "../src/wallet.js";

describe("gatewaySignerFromWallet", () => {
  it("derives auth signing from Anchor Wallet.payer", async () => {
    const keypair = Keypair.generate();
    const wallet = new Wallet(keypair);
    const signer = gatewaySignerFromWallet(wallet);
    expect(signer).toBeDefined();
    const msg = authMessage(new Uint8Array(32), 1n);
    const sig = await signer!(msg);
    expect(sig).toHaveLength(64);
    expect(await signerFromKeypair(keypair)(msg)).toEqual(sig);
  });

  it("prefers signAuthMessage when set", async () => {
    const keypair = Keypair.generate();
    const wallet = new Wallet(keypair);
    const custom = async () => new Uint8Array(64);
    const molpha = Object.assign(wallet, { signAuthMessage: custom }) as MolphaWallet;
    const signer = gatewaySignerFromWallet(molpha);
    expect(await signer!(new Uint8Array(1))).toEqual(new Uint8Array(64));
  });
});
