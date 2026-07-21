/**
 * `MolphaSolanaClient` — consumer on-chain surface only (subscribe, extend,
 * submitDataUpdate, readFeed/readPlan/readSubscription,
 * getRegistrySelectionConfig, verifyNodeKeysForPrivateApi). Built from an
 * Anchor `Program` over the vendored IDL.
 */
import {
  AnchorProvider,
  Program,
  type Idl,
  type Wallet,
} from "@anchor-lang/core";
import BN from "bn.js";
import type { Address } from "@solana/kit";
import { hexToBytes, toFixedBytes } from "../core/encoding.js";
import {
  normalizeSecp256k1PublicKeyHex,
  secp256k1PublicKeyFromCoordinates,
} from "../core/nodeKeys.js";
import type { DataUpdateResult, Node, NodeKeyVerifierArgs, RegistrySelectionConfig } from "../core/types.js";
import {
  type RegistryStateView,
  resolveRegistryIndexForVersion,
  resolveRemainingAccounts,
} from "./accounts.js";
import {
  getAssociatedTokenAddressSync,
  setComputeUnitLimit,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  toSolanaAddress,
  type SolanaAddress,
  type SolanaConnection,
} from "./kit.js";
import {
  feedPda,
  nodePda,
  planPda,
  protocolConfigPda,
  registryStatePda,
  subscriptionPda,
} from "./pdas.js";
import { MOLPHA_IDL, MOLPHA_PROGRAM_ADDRESS } from "../../idl/index.js";
import { PlanType, planIdFromVariant, planVariant, type PlanId } from "./plans.js";

export { PlanType, type PlanId } from "./plans.js";

const DEFAULT_COMPUTE_UNIT_LIMIT = 700_000;
type Commitment = NonNullable<ConstructorParameters<typeof AnchorProvider>[2]>["commitment"];

export interface SubscribeResult {
  signature: string;
  /** USDC base units actually debited from the owner for this subscription. */
  pricePaid: bigint;
}

export interface PlanInfo {
  planType: PlanType;
  /** Subscription price in USDC base units (raw u64, e.g. 1_000_000 = 1 USDC at 6 decimals). */
  subscriptionPrice: bigint;
  maxSigners: number;
  maxDelegates: number;
  privateApiEnabled: boolean;
  isActive: boolean;
}

export interface SubscriptionInfo {
  owner: Address;
  planType: PlanType;
  /** USDC base units prepaid on the subscription vault. */
  prepaidUsdc: bigint;
  /** Locked subscription price in USDC base units for the current period. */
  price: bigint;
  /** Unix timestamp (seconds) until which the subscription is valid. */
  validUntil: bigint;
  usedRounds: bigint;
  maxRounds: bigint;
  delegateCount: number;
  maxDelegates: number;
  maxSigners: number;
}

export interface SubmitResult {
  signature: string;
}

export interface FeedAccount {
  feedId: number[];
  value: number[];
  valueKind: { value: Record<string, never> } | { hash: Record<string, never> };
  canonicalTimestamp: BN;
  signaturesRequired: number;
  signersBitmap: number[];
  registryVersion: number;
  bump: number;
}

interface NodeAccount {
  secp256k1PubkeyX?: Uint8Array | number[];
  secp256k1PubkeyY?: Uint8Array | number[];
  secp256k1_pubkey_x?: Uint8Array | number[];
  secp256k1_pubkey_y?: Uint8Array | number[];
}

interface CreateClientOpts {
  connection: SolanaConnection;
  wallet: Wallet;
  programId?: SolanaAddress;
  idl?: Idl;
  commitment?: Commitment;
}

export class MolphaSolanaClient {
  private constructor(
    private readonly program: Program,
    private readonly provider: AnchorProvider,
    readonly programId: Address,
  ) {}

  static create(opts: CreateClientOpts): MolphaSolanaClient {
    const programId = toSolanaAddress(opts.programId ?? MOLPHA_PROGRAM_ADDRESS);
    const provider = new AnchorProvider(opts.connection, opts.wallet, {
      commitment: opts.commitment ?? "confirmed",
    });
    // Anchor reads the program id from `idl.address`; override it so the
    // caller-supplied programId always wins without mutating the vendored copy.
    const idl: Idl = { ...(opts.idl ?? MOLPHA_IDL), address: programId };
    const program = new Program(idl, provider);
    return new MolphaSolanaClient(program, provider, programId);
  }

  private get wallet(): Address {
    return toSolanaAddress(this.provider.wallet.publicKey);
  }

  /** Anchor's method/account namespaces are untyped without an IDL type param. */
  private get methods(): any {
    return this.program.methods;
  }
  private get accounts(): any {
    return this.program.account;
  }

  /**
   * Current registry version and selection `redundancy_buffer` from a single
   * `RegistryState` account read. Prefer this over {@link getRegistryVersion}
   * when deriving gateway selection bitmaps.
   */
  async getRegistrySelectionConfig(): Promise<RegistrySelectionConfig> {
    const registry = await this.fetchRegistry();
    return {
      registryVersion: registry.currentVersion,
      redundancyBuffer: registry.redundancyBuffer,
    };
  }

  async getRegistryVersion(): Promise<number> {
    const { registryVersion } = await this.getRegistrySelectionConfig();
    return registryVersion;
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
  async readSubscription(owner: SolanaAddress = this.wallet): Promise<SubscriptionInfo | null> {
    const account = await this.accounts.subscription.fetchNullable(
      subscriptionPda(owner, this.programId),
    );
    if (!account) return null;
    return {
      owner: toSolanaAddress(account.owner),
      planType: planIdFromVariant(account.planType) as unknown as PlanType,
      prepaidUsdc: BigInt(account.prepaidUsdc.toString()),
      price: BigInt(account.price.toString()),
      validUntil: BigInt(account.validUntil.toString()),
      usedRounds: BigInt(account.usedRounds.toString()),
      maxRounds: BigInt(account.maxRounds.toString()),
      delegateCount: account.delegateCount,
      maxDelegates: account.maxDelegates,
      maxSigners: account.maxSigners,
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
    opts: { maxPriceUsdc: bigint | number | BN; ownerUsdc?: SolanaAddress },
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
        systemProgram: SYSTEM_PROGRAM_ADDRESS,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
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
    opts: { maxPriceUsdc: bigint | number | BN; ownerUsdc?: SolanaAddress },
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
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
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

  async submitDataUpdate(
    result: DataUpdateResult,
    opts?: { computeUnitLimit?: number },
  ): Promise<SubmitResult> {
    const registry = await this.fetchRegistry();
    const feedId = hexToBytes(result.feedId);
    const remaining = resolveRemainingAccounts(result, registry, this.programId);
    const cuIx = setComputeUnitLimit(opts?.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT);

    const signature = await this.methods
      .submitDataUpdate(this.buildSubmitArgs(result))
      .accounts({
        submitter: this.wallet,
        registryState: registryStatePda(this.programId),
        feed: feedPda(feedId, this.programId),
        systemProgram: SYSTEM_PROGRAM_ADDRESS,
      })
      .remainingAccounts(remaining)
      .preInstructions([cuIx])
      .rpc();
    return { signature };
  }

  async readFeed(feedId: string): Promise<FeedAccount | null> {
    const feed = feedPda(hexToBytes(feedId), this.programId);
    return (await this.accounts.feed.fetchNullable(feed)) as FeedAccount | null;
  }

  /**
   * Authenticate gateway-provided private API encryption keys against the
   * on-chain Node accounts for the round's registry version.
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
        const account = await this.fetchNodeAccount(registryIndex, node.index);
        const onChainKey = secp256k1PublicKeyFromCoordinates(
          nodeCoordinate(account, "secp256k1PubkeyX", "secp256k1_pubkey_x"),
          nodeCoordinate(account, "secp256k1PubkeyY", "secp256k1_pubkey_y"),
          `Node(${registryIndex}) secp256k1 public key`,
        );
        const gatewayKey = normalizeSecp256k1PublicKeyHex(
          node.signingKey,
          `Gateway selected node ${node.index} signingKey`,
        );
        if (gatewayKey !== onChainKey) {
          throw new Error(
            `Gateway selected node ${node.index} signingKey does not match on-chain Node(${registryIndex})`,
          );
        }
      }),
    );
  }

  private buildSubmitArgs(result: DataUpdateResult) {
    return {
      feedId: Array.from(hexToBytes(result.feedId)),
      registryVersion: result.registryVersion,
      value: Buffer.from(hexToBytes(result.valuePacked)),
      canonicalTimestamp: new BN(result.timestamp),
      signaturesRequired: result.signaturesRequired,
      aggSigS: Array.from(toFixedBytes(result.s, 32, "s")),
      commitmentAddr: Array.from(toFixedBytes(result.commitmentAddr, 20, "commitmentAddr")),
      signersBitmap: Array.from(toFixedBytes(result.signersBitmap, 32, "signersBitmap")),
    };
  }

  private decodePlan(account: {
    planType: Record<string, unknown>;
    subscriptionPrice: { toString(): string };
    maxSigners: number;
    maxDelegates: number;
    privateApiEnabled: boolean;
    isActive: boolean;
  }): PlanInfo {
    return {
      planType: planIdFromVariant(account.planType) as unknown as PlanType,
      subscriptionPrice: BigInt(account.subscriptionPrice.toString()),
      maxSigners: account.maxSigners,
      maxDelegates: account.maxDelegates,
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
      redundancyBuffer: registry.redundancyBuffer,
      lastTransitionType: registry.lastTransitionType,
      removedOldIndex: registry.removedOldIndex,
      movedOldIndex: registry.movedOldIndex,
    };
  }

  private async fetchNodeAccount(
    registryIndex: number,
    selectedNodeIndex: number,
  ): Promise<NodeAccount> {
    try {
      return await this.accounts.node.fetch(nodePda(registryIndex, this.programId));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to fetch on-chain Node(${registryIndex}) for selected node ${selectedNodeIndex}: ${detail}`,
      );
    }
  }

  private async fetchProtocolTokens(): Promise<{ usdcMint: Address; treasury: Address }> {
    const config = await this.accounts.protocolConfig.fetch(
      protocolConfigPda(this.programId),
    );
    return {
      usdcMint: toSolanaAddress(config.usdcMint),
      treasury: toSolanaAddress(config.treasury),
    };
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

function nodeCoordinate(
  account: NodeAccount,
  camelCaseField: "secp256k1PubkeyX" | "secp256k1PubkeyY",
  snakeCaseField: "secp256k1_pubkey_x" | "secp256k1_pubkey_y",
): Uint8Array {
  const value = account[camelCaseField] ?? account[snakeCaseField];
  if (!(value instanceof Uint8Array) && !Array.isArray(value)) {
    throw new Error(`Node account is missing ${camelCaseField}`);
  }
  return toFixedBytes(Uint8Array.from(value), 32, `Node.${camelCaseField}`);
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
