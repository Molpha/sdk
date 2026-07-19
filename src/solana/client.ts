/**
 * `MolphaSolanaClient` — consumer on-chain surface only (subscribe, extend,
 * createJob, submitDataUpdate, readFeed/readPlan/readSubscription/readJob,
 * getRegistryVersion, verify). Built from
 * an Anchor `Program` over the vendored IDL.
 */
import {
  AnchorProvider,
  Program,
  type Idl,
  type Wallet,
} from "@coral-xyz/anchor";
import BN from "bn.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  type Commitment,
  type Connection,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { bytesToHex, hexToBytes, toFixedBytes } from "../core/encoding.js";
import { deriveJobId } from "../core/ids.js";
import {
  normalizeSecp256k1PublicKeyHex,
  secp256k1PublicKeyFromCoordinates,
} from "../core/nodeKeys.js";
import type { DataUpdateResult, Node, NodeKeyVerifierArgs } from "../core/types.js";
import {
  type RegistryStateView,
  decodeVerifyReturn,
  resolveRegistryIndexForVersion,
  resolveRemainingAccounts,
} from "./accounts.js";
import {
  feedPda,
  jobPda,
  planPda,
  protocolConfigPda,
  registryIndexPda,
  registryStatePda,
  subscriptionPda,
} from "./pdas.js";
import { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "../../idl/index.js";
import { PlanType, planIdFromVariant, planVariant, type PlanId } from "./plans.js";

export { PlanType, type PlanId } from "./plans.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
const DEFAULT_COMPUTE_UNIT_LIMIT = 700_000;

export interface SubscribeResult {
  signature: string;
  /** USDC base units actually debited from the owner for this subscription. */
  pricePaid: bigint;
}

export interface PlanInfo {
  planType: PlanType;
  /** Subscription price in USDC base units (raw u64, e.g. 1_000_000 = 1 USDC at 6 decimals). */
  subscriptionPrice: bigint;
  maxJobs: number;
  maxSigners: number;
  privateApiEnabled: boolean;
  isActive: boolean;
}

export interface SubscriptionInfo {
  owner: PublicKey;
  planType: PlanType;
  /** USDC base units prepaid on the subscription vault. */
  prepaidUsdc: bigint;
  /** Locked subscription price in USDC base units for the current period. */
  price: bigint;
  /** Unix timestamp (seconds) until which the subscription is valid. */
  validUntil: bigint;
  jobCount: number;
}

export interface JobInfo {
  /** 32-byte job id, hex. */
  jobId: string;
  owner: PublicKey;
  delegates: PublicKey[];
  delegateCount: number;
  /** 32-byte API config hash, hex. */
  apiConfigHash: string;
  decimals: number;
  signaturesRequired: number;
  /** Unix timestamp (seconds) when the job was created. */
  createdAt: bigint;
}

export interface CreateJobResult {
  signature: string;
  /** 32-byte job id, hex. */
  jobId: string;
}
export interface SubmitResult {
  signature: string;
}

export interface FeedAccount {
  jobId: number[];
  registryVersion: number;
  canonicalTimestamp: BN;
  value: number[];
  signersBitmap: number[];
  signaturesRequired: number;
  lastUpdatedSlot: BN;
  bump: number;
}

interface RegistryIndexAccount {
  secp256k1PubkeyX?: Uint8Array | number[];
  secp256k1PubkeyY?: Uint8Array | number[];
  secp256k1_pubkey_x?: Uint8Array | number[];
  secp256k1_pubkey_y?: Uint8Array | number[];
}

interface CreateClientOpts {
  connection: Connection;
  wallet: Wallet;
  programId?: PublicKey;
  idl?: Idl;
  commitment?: Commitment;
}

export class MolphaSolanaClient {
  private constructor(
    private readonly program: Program,
    private readonly provider: AnchorProvider,
    readonly programId: PublicKey,
  ) {}

  static create(opts: CreateClientOpts): MolphaSolanaClient {
    const programId = opts.programId ?? new PublicKey(MOLPHA_PROGRAM_ADDRESS);
    const provider = new AnchorProvider(opts.connection, opts.wallet, {
      commitment: opts.commitment ?? "confirmed",
    });
    // Anchor 0.30 reads the program id from `idl.address`; override it so the
    // caller-supplied programId always wins without mutating the vendored copy.
    const idl: Idl = { ...(opts.idl ?? MOLPHA_IDL), address: programId.toBase58() };
    const program = new Program(idl, provider);
    return new MolphaSolanaClient(program, provider, programId);
  }

  private get wallet(): PublicKey {
    return this.provider.wallet.publicKey;
  }

  /** Anchor's method/account namespaces are untyped without an IDL type param. */
  private get methods(): any {
    return this.program.methods;
  }
  private get accounts(): any {
    return this.program.account;
  }

  async getRegistryVersion(): Promise<number> {
    const registry = await this.fetchRegistry();
    return registry.currentVersion;
  }

  /** Fetch a plan's on-chain terms, including the USDC `subscriptionPrice` charged on `subscribe`. */
  async getPlan(plan: PlanType): Promise<PlanInfo> {
    const info = await this.readPlan(plan);
    if (!info) {
      throw new Error(`plan account not found for ${PlanType[plan] ?? plan}`);
    }
    return info;
  }

  /** Read a plan account, or `null` if it has not been initialized. */
  async readPlan(plan: PlanType): Promise<PlanInfo | null> {
    const account = await this.accounts.plan.fetchNullable(planPda(plan as PlanId, this.programId));
    return account ? this.decodePlan(account) : null;
  }

  /** Read an owner's subscription, or `null` if they have not subscribed. */
  async readSubscription(owner: PublicKey = this.wallet): Promise<SubscriptionInfo | null> {
    const account = await this.accounts.subscription.fetchNullable(
      subscriptionPda(owner, this.programId),
    );
    if (!account) return null;
    return {
      owner: account.owner,
      planType: planIdFromVariant(account.planType) as unknown as PlanType,
      prepaidUsdc: BigInt(account.prepaidUsdc.toString()),
      price: BigInt(account.price.toString()),
      validUntil: BigInt(account.validUntil.toString()),
      jobCount: account.jobCount,
    };
  }

  /** Read a job account by id, or `null` if it does not exist. */
  async readJob(jobId: string): Promise<JobInfo | null> {
    const account = await this.accounts.job.fetchNullable(
      jobPda(hexToBytes(jobId), this.programId),
    );
    if (!account) return null;
    const delegates: PublicKey[] = [];
    for (let i = 0; i < account.delegateCount; i++) {
      delegates.push(account.delegates[i]);
    }
    return {
      jobId: bytesToHex(Uint8Array.from(account.jobId)),
      owner: account.owner,
      delegates,
      delegateCount: account.delegateCount,
      apiConfigHash: bytesToHex(Uint8Array.from(account.apiConfigHash)),
      decimals: account.decimals,
      signaturesRequired: account.signaturesRequired,
      createdAt: BigInt(account.createdAt.toString()),
    };
  }

  /**
   * Subscribe to a plan. This **debits USDC** from the owner: the plan's
   * `subscriptionPrice` is transferred to the protocol treasury on-chain.
   *
   * Payment is explicit and must be confirmed: pass `maxPriceUsdc` (USDC base
   * units) as the most you agree to pay. The SDK reads the live on-chain price
   * and aborts before sending the transaction if it exceeds that amount, so a
   * price change between display and confirmation can never silently overcharge.
   * The amount actually paid is returned as `pricePaid`.
   *
   * Use {@link getPlan} to display the current price to the user beforehand.
   */
  async subscribe(
    plan: PlanType,
    opts: { maxPriceUsdc: bigint | number | BN; ownerUsdc?: PublicKey },
  ): Promise<SubscribeResult> {
    const planId = plan as PlanId;
    const owner = this.wallet;
    const { usdcMint, treasury } = await this.fetchProtocolTokens();
    const price = await this.confirmPlanPrice(planId, opts.maxPriceUsdc, "subscribe");
    const ownerUsdc = opts.ownerUsdc ?? getAssociatedTokenAddressSync(usdcMint, owner);

    const signature = await this.methods
      .subscribe(planVariant(planId))
      .accounts({
        owner,
        protocolConfig: protocolConfigPda(this.programId),
        plan: planPda(planId, this.programId),
        subscription: subscriptionPda(owner, this.programId),
        usdcMint,
        ownerUsdc,
        treasury,
        systemProgram: SYSTEM_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    return { signature, pricePaid: price };
  }

  /**
   * Extend the current subscription for another period. Like {@link subscribe}
   * this **debits USDC** (the plan's `subscriptionPrice`) and requires explicit
   * payment confirmation via `maxPriceUsdc`.
   */
  async extendSubscription(
    opts: { maxPriceUsdc: bigint | number | BN; ownerUsdc?: PublicKey },
  ): Promise<SubscribeResult> {
    const owner = this.wallet;
    const subscription = subscriptionPda(owner, this.programId);
    const sub = await this.accounts.subscription.fetch(subscription);
    const planId = planIdFromVariant(sub.planType);
    const { usdcMint, treasury } = await this.fetchProtocolTokens();
    const price = await this.confirmPlanPrice(planId, opts.maxPriceUsdc, "extendSubscription");
    const ownerUsdc = opts.ownerUsdc ?? getAssociatedTokenAddressSync(usdcMint, owner);

    const signature = await this.methods
      .extendSubscription()
      .accounts({
        owner,
        protocolConfig: protocolConfigPda(this.programId),
        subscription,
        plan: planPda(planId, this.programId),
        usdcMint,
        ownerUsdc,
        treasury,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    return { signature, pricePaid: price };
  }

  /**
   * Read the live on-chain plan price and verify it does not exceed the amount
   * the caller agreed to pay. Returns the price (USDC base units) on success.
   */
  private async confirmPlanPrice(
    planId: PlanId,
    maxPriceUsdc: bigint | number | BN,
    method: string,
  ): Promise<bigint> {
    const max = toUsdcBaseUnits(maxPriceUsdc, "maxPriceUsdc");
    const plan = await this.accounts.plan.fetch(planPda(planId, this.programId));
    const price = BigInt(plan.subscriptionPrice.toString());
    if (price > max) {
      throw new Error(
        `${method}: plan price ${price} USDC base units exceeds the confirmed maximum ${max}. ` +
          "The on-chain price may have changed — re-confirm the current price before paying.",
      );
    }
    return price;
  }

  async createJob(
    args: { apiConfigHash: Uint8Array; signaturesRequired: number; decimals: number },
    owner: PublicKey = this.wallet,
  ): Promise<CreateJobResult> {
    const apiConfigHash = toFixedBytes(args.apiConfigHash, 32, "apiConfigHash");
    const subscription = subscriptionPda(owner, this.programId);
    const sub = await this.accounts.subscription.fetch(subscription);
    const planId = planIdFromVariant(sub.planType);

    const jobId = deriveJobId(owner.toBytes(), apiConfigHash);

    const signature = await this.methods
      .createJob(
        {
          apiConfigHash: Array.from(apiConfigHash),
          signaturesRequired: args.signaturesRequired,
          decimals: args.decimals,
        },
        Array.from(jobId),
      )
      .accounts({
        owner,
        protocolConfig: protocolConfigPda(this.programId),
        plan: planPda(planId, this.programId),
        job: jobPda(jobId, this.programId),
        subscription,
        feed: feedPda(jobId, this.programId),
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc();
    return { signature, jobId: bytesToHex(jobId) };
  }

  async submitDataUpdate(
    result: DataUpdateResult,
    opts?: { computeUnitLimit?: number },
  ): Promise<SubmitResult> {
    const registry = await this.fetchRegistry();
    const jobId = hexToBytes(result.jobId);
    const remaining = resolveRemainingAccounts(result, registry, this.programId);
    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: opts?.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT,
    });

    const signature = await this.methods
      .submitDataUpdate(this.buildSubmitArgs(result))
      .accounts({
        submitter: this.wallet,
        registryState: registryStatePda(this.programId),
        feed: feedPda(jobId, this.programId),
      })
      .remainingAccounts(remaining)
      .preInstructions([cuIx])
      .rpc();
    return { signature };
  }

  async readFeed(jobId: string): Promise<FeedAccount | null> {
    const feed = feedPda(hexToBytes(jobId), this.programId);
    return (await this.accounts.feed.fetchNullable(feed)) as FeedAccount | null;
  }

  async verifyDataUpdate(
    result: DataUpdateResult,
  ): Promise<{ value: string; canonicalTimestamp: string }> {
    const registry = await this.fetchRegistry();
    const remaining = resolveRemainingAccounts(result, registry, this.programId);

    const ix = await this.methods
      .verifyDataUpdate(this.buildSubmitArgs(result))
      .accounts({ registryState: registryStatePda(this.programId) })
      .remainingAccounts(remaining)
      .instruction();

    const tx = new Transaction().add(ix);
    tx.feePayer = this.wallet;
    const { connection } = this.provider;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const sim = await connection.simulateTransaction(tx);
    const ret = sim.value.returnData;
    if (!ret) {
      throw new Error(`verify_data_update returned no data: ${sim.value.err ?? "unknown"}`);
    }
    return decodeVerifyReturn(base64ToBytes(ret.data[0]));
  }

  /**
   * Authenticate gateway-provided private API encryption keys against the
   * on-chain registry index accounts for the round's registry version.
   */
  async verifyNodeKeysForPrivateApi(args: NodeKeyVerifierArgs): Promise<void> {
    const registry = await this.fetchRegistry();
    const selectedNodes = selectedNodesForVerifier(args);

    await Promise.all(
      selectedNodes.map(async (node) => {
        const registryIndex = resolveRegistryIndexForVersion(
          node.index,
          args.registryVersion,
          registry,
        );
        const account = await this.fetchRegistryIndexAccount(registryIndex, node.index);
        const onChainKey = secp256k1PublicKeyFromCoordinates(
          registryIndexCoordinate(account, "secp256k1PubkeyX", "secp256k1_pubkey_x"),
          registryIndexCoordinate(account, "secp256k1PubkeyY", "secp256k1_pubkey_y"),
          `RegistryIndex(${registryIndex}) secp256k1 public key`,
        );
        const gatewayKey = normalizeSecp256k1PublicKeyHex(
          node.signingKey,
          `Gateway selected node ${node.index} signingKey`,
        );
        if (gatewayKey !== onChainKey) {
          throw new Error(
            `Gateway selected node ${node.index} signingKey does not match on-chain RegistryIndex(${registryIndex})`,
          );
        }
      }),
    );
  }

  private buildSubmitArgs(result: DataUpdateResult) {
    return {
      jobId: Array.from(hexToBytes(result.jobId)),
      signaturesRequired: result.signaturesRequired,
      registryVersion: result.registryVersion,
      signersBitmap: Array.from(toFixedBytes(result.signersBitmap, 32, "signersBitmap")),
      value: Array.from(toFixedBytes(result.valuePacked, 32, "valuePacked")),
      canonicalTimestamp: new BN(result.timestamp),
      aggSigS: Array.from(toFixedBytes(result.s, 32, "s")),
      commitmentAddr: Array.from(toFixedBytes(result.commitmentAddr, 20, "commitmentAddr")),
    };
  }

  private decodePlan(account: {
    planType: Record<string, unknown>;
    subscriptionPrice: { toString(): string };
    maxJobs: number;
    maxSigners: number;
    privateApiEnabled: boolean;
    isActive: boolean;
  }): PlanInfo {
    return {
      planType: planIdFromVariant(account.planType) as unknown as PlanType,
      subscriptionPrice: BigInt(account.subscriptionPrice.toString()),
      maxJobs: account.maxJobs,
      maxSigners: account.maxSigners,
      privateApiEnabled: account.privateApiEnabled,
      isActive: account.isActive,
    };
  }

  private async fetchRegistry(): Promise<RegistryStateView> {
    const registry = await this.accounts.registryState.fetch(
      registryStatePda(this.programId),
    );
    return {
      currentVersion: registry.currentVersion,
      previousVersion: registry.previousVersion,
      previousExpiresAt: BigInt(registry.previousExpiresAt.toString()),
      lastTransitionType: registry.lastTransitionType,
      removedOldIndex: registry.removedOldIndex,
      movedOldIndex: registry.movedOldIndex,
    };
  }

  private async fetchRegistryIndexAccount(
    registryIndex: number,
    selectedNodeIndex: number,
  ): Promise<RegistryIndexAccount> {
    try {
      return await this.accounts.registryIndex.fetch(
        registryIndexPda(registryIndex, this.programId),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to fetch on-chain RegistryIndex(${registryIndex}) for selected node ${selectedNodeIndex}: ${detail}`,
      );
    }
  }

  private async fetchProtocolTokens(): Promise<{ usdcMint: PublicKey; treasury: PublicKey }> {
    const config = await this.accounts.protocolConfig.fetch(
      protocolConfigPda(this.programId),
    );
    return { usdcMint: config.usdcMint, treasury: config.treasury };
  }
}

/** Normalize a confirmed USDC amount (base units) to `bigint`, rejecting non-integers. */
function toUsdcBaseUnits(amount: bigint | number | BN, label: string): bigint {
  if (typeof amount === "bigint") {
    if (amount < 0n) throw new Error(`${label} must be non-negative, got ${amount}`);
    return amount;
  }
  if (typeof amount === "number") {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new Error(`${label} must be a non-negative integer of USDC base units, got ${amount}`);
    }
    return BigInt(amount);
  }
  return BigInt(amount.toString());
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function registryIndexCoordinate(
  account: RegistryIndexAccount,
  camelCaseField: "secp256k1PubkeyX" | "secp256k1PubkeyY",
  snakeCaseField: "secp256k1_pubkey_x" | "secp256k1_pubkey_y",
): Uint8Array {
  const value = account[camelCaseField] ?? account[snakeCaseField];
  if (!(value instanceof Uint8Array) && !Array.isArray(value)) {
    throw new Error(`RegistryIndex account is missing ${camelCaseField}`);
  }
  return toFixedBytes(Uint8Array.from(value), 32, `RegistryIndex.${camelCaseField}`);
}

function selectedNodesForVerifier(args: NodeKeyVerifierArgs): Node[] {
  if (args.selectedIndexes.length === 0) {
    throw new Error("Private API node-key verification requires at least one selected index");
  }
  if (args.selectedNodes.length !== args.selectedIndexes.length) {
    throw new Error(
      `Private API node-key verification expected ${args.selectedIndexes.length} selected nodes, got ${args.selectedNodes.length}`,
    );
  }

  const expected = new Set<number>();
  for (const index of args.selectedIndexes) {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Private API selected index must be a non-negative integer: ${index}`);
    }
    if (expected.has(index)) {
      throw new Error(`Private API selected index is duplicated: ${index}`);
    }
    expected.add(index);
  }

  const byIndex = new Map<number, Node>();
  for (const node of args.selectedNodes) {
    if (!Number.isInteger(node.index) || node.index < 0) {
      throw new Error(
        `Private API selected node index must be a non-negative integer: ${node.index}`,
      );
    }
    if (!expected.has(node.index)) {
      throw new Error(`Private API selected node ${node.index} was not requested`);
    }
    if (byIndex.has(node.index)) {
      throw new Error(`Private API selected node index is duplicated: ${node.index}`);
    }
    byIndex.set(node.index, node);
  }

  return args.selectedIndexes.map((index) => {
    const node = byIndex.get(index);
    if (!node) {
      throw new Error(`Private API selected node is missing for index: ${index}`);
    }
    return node;
  });
}
