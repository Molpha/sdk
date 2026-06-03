import type { Idl } from "@coral-xyz/anchor";
import idlJson from "./molpha.json" with { type: "json" };

/**
 * Vendored Molpha Anchor IDL (`target/idl/molpha.json` from the program repo).
 *
 * It is re-exported here as a convenience default so consumers can do
 * `MolphaSolanaClient.create({ idl: MOLPHA_IDL, ... })`. The client never
 * hard-imports it — pass any compatible IDL in via `create({ idl })`. Pin the
 * vendored copy to the deployed program version in your release process.
 */
export const MOLPHA_IDL = idlJson as Idl;

/** Program address baked into the vendored IDL. */
export const MOLPHA_PROGRAM_ADDRESS: string = idlJson.address;
