/**
 * `@molpha/sdk` — Consumer SDK public surface.
 *
 * The `MolphaSDK` facade wires the gateway and Solana clients together; consumers
 * who only read or only run gateway rounds can use `sdk.gateway` / `sdk.solana`
 * directly (or import `MolphaGateway` / `MolphaSolanaClient` standalone).
 */
import type { Commitment, Connection } from "@solana/web3.js";
import type { PublicKey } from "@solana/web3.js";
import type { Idl, Wallet } from "@coral-xyz/anchor";
import { type ExecuteOptions, MolphaGateway } from "./gateway/index.js";
import { MolphaSolanaClient } from "./solana/client.js";
import type { DataUpdateResult, Signer } from "./core/types.js";

// Public re-exports.
export * from "./core/index.js";
export * from "./gateway/index.js";
export * from "./solana/index.js";
export { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "../idl/index.js";

export interface MolphaSDKOptions {
  endpoints: string | string[];
  connection: Connection;
  wallet: Wallet;
  programId: PublicKey;
  idl: Idl;
  /** Default authSig signer for gateway calls. */
  signer?: Signer;
  commitment?: Commitment;
}

export class MolphaSDK {
  readonly gateway: MolphaGateway;
  readonly solana: MolphaSolanaClient;
  private readonly defaultSigner?: Signer;

  constructor(opts: MolphaSDKOptions) {
    this.gateway = new MolphaGateway(opts.endpoints);
    this.solana = MolphaSolanaClient.create({
      connection: opts.connection,
      wallet: opts.wallet,
      programId: opts.programId,
      idl: opts.idl,
      ...(opts.commitment ? { commitment: opts.commitment } : {}),
    });
    if (opts.signer) this.defaultSigner = opts.signer;
  }

  /**
   * Resolve the current `registryVersion` from Solana, run the gateway round, and
   * submit the signed result to the feed — one shared round definition.
   */
  async executeAndSubmit(
    jobId: string,
    opts: Omit<ExecuteOptions, "jobId" | "registryVersion">,
  ): Promise<{ result: DataUpdateResult; signature: string }> {
    const registryVersion = await this.solana.getRegistryVersion();
    const result = await this.gateway.execute({
      jobId,
      registryVersion,
      ...(this.defaultSigner ? { signer: this.defaultSigner } : {}),
      ...opts,
    });
    const { signature } = await this.solana.submitDataUpdate(result);
    return { result, signature };
  }
}
