/**
 * Bootstrap the protocol registry by checking top vaults on Base.
 *
 * Usage: pnpm exec tsx scripts/bootstrap-registry.ts
 *
 * Requires: VAULTSFYI_API_KEY in .env
 */
import * as dotenv from "dotenv";
dotenv.config({ quiet: true });

import { VaultsSdk } from "@vaultsfyi/sdk";
import { ProtocolRegistry } from "../src/modules/protocol-registry";
import { PROTOCOL_REGISTRY_PATH } from "../src/paths";

const apiKey = process.env.VAULTSFYI_API_KEY;
if (!apiKey) {
  console.error("VAULTSFYI_API_KEY not set in .env");
  process.exit(1);
}

async function main() {
  const sdk = new VaultsSdk({ apiKey });
  const registry = new ProtocolRegistry(PROTOCOL_REGISTRY_PATH);

  for (const asset of ["usdc", "wbtc", "cbbtc"]) {
    console.log(`\nFetching top ${asset} vaults on Base...`);
    const vaults = await sdk.getAllVaults({
      query: {
        allowedAssets: [asset],
        allowedNetworks: ["base"],
        sortBy: "apy7day",
        sortOrder: "desc",
        perPage: 20,
        page: 1,
        onlyTransactional: true,
        minTvl: 100_000,
      },
    });

    for (const vault of vaults.data) {
      if (registry.lookup(vault.address, "base")) {
        console.log(`  [skip] ${vault.protocol} ${vault.symbol} — already in registry`);
        continue;
      }

      try {
        const context = await sdk.getTransactionsContext({
          path: {
            userAddress: "0x0000000000000000000000000000000000000001",
            vaultAddress: vault.address,
            network: "base",
          },
        });

        const redeemType = (context as any).redeemStepsType === "instant"
          ? "instant" as const
          : "complex" as const;

        registry.add(vault.address, "base", {
          protocol: vault.protocol || "unknown",
          symbol: vault.symbol || asset,
          redeemType,
          checkedAt: new Date().toISOString(),
        });

        console.log(`  [${redeemType}] ${vault.protocol} ${vault.symbol} (${vault.address})`);
      } catch (err) {
        console.error(`  [error] ${vault.protocol} ${vault.symbol}: ${err}`);
      }
    }
  }

  const all = registry.getAll();
  const instantCount = Object.values(all).filter(v => v.redeemType === "instant").length;
  const complexCount = Object.values(all).filter(v => v.redeemType === "complex").length;
  console.log(`\nDone. Registry: ${instantCount} instant, ${complexCount} complex.`);
  console.log(`Saved to: ${PROTOCOL_REGISTRY_PATH}`);
}

main().catch(console.error);
