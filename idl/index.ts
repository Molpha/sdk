import type { Idl } from "@anchor-lang/core";
import idlJson from "./molpha.json" with { type: "json" };

/**
 * Vendored Molpha Anchor IDL (`target/idl/molpha.json` from the program repo).
 *
 * Re-exported as `MOLPHA_IDL` and used as the default in `MolphaSDK` /
 * `MolphaSolanaClient.create`. Pass `idl` / `programId` only when pinning a
 * different deployment. Keep this copy aligned with the on-chain program you target.
 */
export const MOLPHA_IDL = idlJson as Idl;

/** Program address baked into the vendored IDL. */
export const MOLPHA_PROGRAM_ADDRESS: string = idlJson.address;
