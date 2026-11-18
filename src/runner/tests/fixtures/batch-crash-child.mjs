/** Child for process-kill durability tests only; never shipped as an API route.
 * The parent sends SIGKILL after receiving an IPC checkpoint from this child.
 */
import { randomUUID } from "node:crypto";
import { admitWorkflowBatch } from "../../batch-workflows.mjs";

const [dataDir, stopAt] = process.argv.slice(2);
const tasks = [
  { id: "build", role: "devops_engineer", dependsOn: [],
    request: { label: "Build before crash",
      files: { "src/backend/domain/X.cs": "namespace X; public class X {}" },
      steps: ["dotnet-build"] } },
  { id: "verify", role: "tester", dependsOn: ["build"],
    request: { label: "Verify after crash",
      files: { "src/backend/domain/X.cs": "namespace X; public class X {}" },
      steps: ["dotnet-build"] } },
];
try {
  await admitWorkflowBatch({
    dataDir, idempotencyKey: randomUUID(), maxQueued: 6, maxRetained: 10,
    input: { consent: true, enforced: true, label: "SIGKILL crash matrix", tasks },
    onCommitPhase: async ({phase, workflowId}) => {
      if (phase !== stopAt) return;
      process.send?.({phase, workflowId});
      // Keep the event loop alive; the parent terminates this process with
      // SIGKILL, bypassing finally/cleanup as in a real abrupt process death.
      await new Promise(() => { setInterval(() => {}, 1000); });
    },
  });
  process.send?.({error: "No crash checkpoint reached"});
} catch (error) {
  process.send?.({error: error.code || error.message});
}
