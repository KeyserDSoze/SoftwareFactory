/** Offline-only host maintenance. Never expose as an authenticated API. */
import { reconcilePendingBatch } from "../batch-recovery.mjs";

const args = process.argv.slice(2);
const ix = args.indexOf("--data-dir"), bi = args.indexOf("--batch-id");
const action = args.includes("--abort") ? "abort" :
  args.includes("--finalize") ? "finalize" : null;
if (args.length !== 5 || ix < 0 || bi < 0 || !action ||
    (args.includes("--abort") && args.includes("--finalize"))) {
  console.error("Usage: node scripts/batch-reconcile.mjs --data-dir /absolute/path --batch-id UUID --abort|--finalize");
  process.exitCode = 2;
} else {
  try {
    const result = await reconcilePendingBatch({
      dataDir: args[ix + 1], id: args[bi + 1], action,
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error("batch_recovery_blocked: stop all API/worker processes and inspect evidence/claims");
    process.exitCode = 1;
  }
}
