/**
 * `@molpha/sdk` — Consumer SDK public surface.
 *
 * The `MolphaSDK` facade wires the gateway and Solana clients together; consumers
 * who only read or only run gateway rounds can use `sdk.gateway` / `sdk.solana`
 * directly (or import `MolphaGateway` / `MolphaSolanaClient` standalone).
 */
import type { Commitment, Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import { type RequestSignedDataOptions, MolphaGateway } from "./gateway/index.js";
import { MolphaSolanaClient } from "./solana/client.js";
import type { DataUpdateResult } from "./core/types.js";
import { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "../idl/index.js";
import { gatewaySignerFromWallet, type MolphaWallet } from "./wallet.js";

// Public re-exports.
export * from "./core/index.js";
export * from "./gateway/index.js";
export * from "./evm/index.js";
export * from "./starknet/index.js";
export * from "./solana/index.js";
export { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "../idl/index.js";
export { gatewaySignerFromWallet, signerFromKeypair, type MolphaWallet } from "./wallet.js";

export interface MolphaSDKOptions {
  /** Defaults to `DEFAULT_GATEWAY_ENDPOINT`. Pass multiple URLs for failover. */
  endpoints?: string | string[];
  connection: Connection;
  /** On-chain txs + gateway auth (see `MolphaWallet`). */
  wallet: MolphaWallet;
  /** Defaults to the vendored IDL's program address. */
  programId?: PublicKey;
  /** Defaults to `MOLPHA_IDL`. Override when pinning a different deployment. */
  idl?: Idl;
  commitment?: Commitment;
}

export class MolphaSDK {
  readonly gateway: MolphaGateway;
  readonly solana: MolphaSolanaClient;

  constructor(opts: MolphaSDKOptions) {
    this.solana = MolphaSolanaClient.create({
      connection: opts.connection,
      wallet: opts.wallet,
      programId: opts.programId ?? new PublicKey(MOLPHA_PROGRAM_ADDRESS),
      idl: opts.idl ?? MOLPHA_IDL,
      ...(opts.commitment ? { commitment: opts.commitment } : {}),
    });
    this.gateway = new MolphaGateway(
      opts.endpoints,
      () => this.solana.getRegistryVersion(),
      gatewaySignerFromWallet(opts.wallet),
      {
        defaultSubscriptionOwner: opts.wallet.publicKey.toBase58(),
        verifyNodeKeys: (args) => this.solana.verifyNodeKeysForPrivateApi(args),
      },
    );
  }

  /**
   * Request a threshold-signed data update from the gateway (against the current
   * on-chain registry version) and submit it to the feed.
   */
  async requestAndSubmit(
    feedId: string,
    opts: Omit<RequestSignedDataOptions, "feedId">,
  ): Promise<{ result: DataUpdateResult; signature: string }> {
    const result = await this.gateway.requestSignedData({ feedId, ...opts });
    const { signature } = await this.solana.submitDataUpdate(result);
    return { result, signature };
  }
}
