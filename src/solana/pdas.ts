/**
 * Consumer PDA derivations (no node PDA). Seed byte strings are cross-checked
 * against the IDL const seeds.
 */
import { PublicKey } from "@solana/web3.js";
import { u32le, utf8 } from "../core/encoding.js";

const SEED_CONFIG = utf8("molpha_config");
const SEED_REGISTRY = utf8("molpha_registry");
const SEED_REGISTRY_INDEX = utf8("molpha_registry_index");
const SEED_PLAN = utf8("molpha_plan");
const SEED_SUBSCRIPTION = utf8("molpha_subscription");
const SEED_JOB = utf8("molpha_job");
const SEED_FEED = utf8("molpha_feed");

/** Virtual registry index used for a removed slot during a version transition. */
export const VIRTUAL_INDEX = 0xffffffff;

const pda = (seeds: Uint8Array[], programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export const protocolConfigPda = (programId: PublicKey): PublicKey =>
  pda([SEED_CONFIG], programId);

export const registryStatePda = (programId: PublicKey): PublicKey =>
  pda([SEED_REGISTRY], programId);

export const registryIndexPda = (index: number, programId: PublicKey): PublicKey =>
  pda([SEED_REGISTRY_INDEX, u32le(index)], programId);

/** Plan PDA is `[b"molpha_plan", [planType as u8]]` in `subscribe/create_job`. */
export const planPda = (planId: number, programId: PublicKey): PublicKey =>
  pda([SEED_PLAN, Uint8Array.of(planId)], programId);

export const subscriptionPda = (owner: PublicKey, programId: PublicKey): PublicKey =>
  pda([SEED_SUBSCRIPTION, owner.toBytes()], programId);

export const jobPda = (jobId: Uint8Array, programId: PublicKey): PublicKey =>
  pda([SEED_JOB, jobId], programId);

export const feedPda = (jobId: Uint8Array, programId: PublicKey): PublicKey =>
  pda([SEED_FEED, jobId], programId);
