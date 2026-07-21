/**
 * Consumer PDA derivations (no node PDA). Seed byte strings are cross-checked
 * against the IDL const seeds.
 */
import type { Address } from "@solana/kit";
import { u32le, utf8 } from "../core/encoding.js";
import {
  addressBytes,
  findProgramAddressSync,
  type SolanaAddress,
} from "./kit.js";

const SEED_CONFIG = utf8("molpha_config");
const SEED_REGISTRY = utf8("molpha_registry");
const SEED_NODE = utf8("molpha_node");
const SEED_PLAN = utf8("molpha_plan");
const SEED_SUBSCRIPTION = utf8("molpha_subscription");
const SEED_FEED = utf8("molpha_feed");

/** Virtual registry index used for a removed slot during a version transition. */
export const VIRTUAL_INDEX = 0xffffffff;

const pda = (seeds: Uint8Array[], programId: SolanaAddress): Address =>
  findProgramAddressSync(seeds, programId);

export const protocolConfigPda = (programId: SolanaAddress): Address =>
  pda([SEED_CONFIG], programId);

export const registryStatePda = (programId: SolanaAddress): Address =>
  pda([SEED_REGISTRY], programId);

/** Slot-keyed `Node` account PDA: `["molpha_node", index u32 LE]`. */
export const nodePda = (index: number, programId: SolanaAddress): Address =>
  pda([SEED_NODE, u32le(index)], programId);

/** Plan PDA is `[b"molpha_plan", [planType as u8]]` in `subscribe`. */
export const planPda = (planId: number, programId: SolanaAddress): Address =>
  pda([SEED_PLAN, Uint8Array.of(planId)], programId);

export const subscriptionPda = (owner: SolanaAddress, programId: SolanaAddress): Address =>
  pda([SEED_SUBSCRIPTION, addressBytes(owner)], programId);

export const feedPda = (feedId: Uint8Array, programId: SolanaAddress): Address =>
  pda([SEED_FEED, feedId], programId);
