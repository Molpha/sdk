import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    node: "src/node.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: true,
  target: "es2022",
  // Solana surface is an optional peer dependency; never bundle it.
  external: ["@coral-xyz/anchor", "@solana/web3.js", "@solana/spl-token"],
});
