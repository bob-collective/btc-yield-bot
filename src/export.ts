import { TxLogger } from "./modules/transactions";
import { DATA_DIR, TX_LOG_PATH } from "./config";
import * as path from "path";
import * as fs from "fs";

const format = process.argv[2] || "json";
const logger = new TxLogger(TX_LOG_PATH);
const entries = logger.getAll();

if (entries.length === 0) {
  console.log("No transactions logged yet.");
  process.exit(0);
}

if (format === "csv") {
  const csv = logger.exportCSV();
  const outPath = path.join(DATA_DIR, "transactions.csv");
  fs.writeFileSync(outPath, csv);
  console.log(`Exported ${entries.length} transactions to ${outPath}`);
} else {
  const json = logger.exportJSON();
  const outPath = path.join(DATA_DIR, "transactions-export.json");
  fs.writeFileSync(outPath, json);
  console.log(`Exported ${entries.length} transactions to ${outPath}`);
}
