import { createServer as httpServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ALLOWED_STEPS, MAX_REQUEST_BYTES, authenticate, validateRequest } from "./common.mjs";
import { portableEvidenceBundle, verifyJobEvidenceForRead } from "./evidence.mjs";
import { readWorkerHeartbeatForHttp, readDockerExecutionReadinessForHttp } from "./heartbeat.mjs";
import { admitRunnerJob } from "./admission.mjs";
import { admitWorkflowBatch, MAX_BATCH_BODY_BYTES } from "./batch-workflows.mjs";
import { projectVerifiedJobPlan } from "./pm-job-plan.mjs";
import { registerWorkflow, getWorkflow } from "./workflows.mjs";
import { registerAgentHandoff, getAgentHandoff, mutateAgentTaskLease, mutateAgentTaskCheckpoint, mutateAgentTaskReview, verifyAgentTestTask, MAX_HANDOFF_BODY_BYTES } from "./agent-handoffs.mjs";
import { loadAgentActorsFile, authenticateAgentActor, reauthorizeAgentActor } from "./agent-actors.mjs";
import { beginRepairSession, getRepairSession, advanceRepairSession } from "./coordinator.mjs";
import { configureRepairOperators, loadRepairOperatorsFile, authenticateRepairOperator, mayRecordRepairAction, reauthorizeRepairMutation } from "./operator-auth.mjs";
import { loadRunnerApiKeyFile } from "./runner-auth.mjs";
import { loadRunnerTenantsFile, authenticateRunnerTenant } from "./tenants.mjs";
import { readWorkerMetrics } from "./host-metrics.mjs";

export function createRunnerServer({
  apiKey = process.env.RUNNER_API_KEY,
  apiKeyFile = process.env.RUNNER_API_KEY_FILE,
  tenantsFile = process.env.RUNNER_TENANTS_FILE,
  agentActorsFile = process.env.RUNNER_AGENT_ACTORS_FILE,
  allowedOrigins = (process.env.RUNNER_ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean),
  dataDir = process.env.RUNNER_DATA_DIR || "/data",
  maxQueued = Number(process.env.RUNNER_MAX_QUEUED || 4),
  maxAcceptedPerMinute = Number(process.env.RUNNER_MAX_ACCEPTED_PER_MINUTE ?? 0),
  workerHeartbeatMaxAgeSeconds = Number(process.env.RUNNER_WORKER_HEARTBEAT_MAX_AGE_SECONDS ?? 30),
  maxRetained = 100,
  admissionWaitMs = 1500,
  repairOperators = process.env.RUNNER_REPAIR_OPERATORS_JSON,
  repairOperatorsFile = process.env.RUNNER_REPAIR_OPERATORS_FILE,
} = {}) {
  const fileMode = apiKeyFile !== undefined && apiKeyFile !== null && apiKeyFile !== "";
  const tenantMode = tenantsFile !== undefined && tenantsFile !== null && tenantsFile !== "";
  if (tenantMode && (fileMode || (apiKey !== undefined && apiKey !== null && apiKey !== "")))
    throw new Error("Configure only one runner authentication source (RUNNER_TENANTS_FILE or API key)");
  if (fileMode && apiKey !== undefined && apiKey !== null && apiKey !== "")
    throw new Error("Configure only one runner API credential source (RUNNER_API_KEY or RUNNER_API_KEY_FILE)");
  if (tenantMode && (typeof tenantsFile !== "string" ||
      !path.isAbsolute(tenantsFile) || tenantsFile.includes("\0")))
    throw new Error("RUNNER_TENANTS_FILE must be an absolute path");
  if (agentActorsFile && (typeof agentActorsFile !== "string" ||
      !path.isAbsolute(agentActorsFile) || agentActorsFile.includes("\0") ||
      [tenantsFile,apiKeyFile,repairOperatorsFile].includes(agentActorsFile)))
    throw new Error("RUNNER_AGENT_ACTORS_FILE must be an independent absolute path");
  // Repair approval has no tenant role/ownership model yet: disallow it
  // altogether in this mode, rather than silently installing a global admin.
  if (tenantMode && (repairOperators || repairOperatorsFile))
    throw new Error("Multi-tenant runner mode forbids repair operator registry");
  if (fileMode && (typeof apiKeyFile !== "string" ||
      !path.isAbsolute(apiKeyFile) || apiKeyFile.includes("\0")))
    throw new Error("RUNNER_API_KEY_FILE must be an absolute path");
  if (!fileMode && !tenantMode && (typeof apiKey !== "string" || apiKey.length < 32))
    throw new Error("RUNNER_API_KEY must contain at least 32 characters");
  if (fileMode && repairOperators)
    throw new Error("File-backed runner key cannot use inline repair operator registry");
  if (!Number.isInteger(maxAcceptedPerMinute) ||
      maxAcceptedPerMinute < 0 || maxAcceptedPerMinute > 100)
    throw new Error("RUNNER_MAX_ACCEPTED_PER_MINUTE must be an integer between 0 and 100");
  if (!Number.isInteger(workerHeartbeatMaxAgeSeconds) ||
      workerHeartbeatMaxAgeSeconds < 10 || workerHeartbeatMaxAgeSeconds > 300)
    throw new Error("RUNNER_WORKER_HEARTBEAT_MAX_AGE_SECONDS must be 10–300");
  if (!allowedOrigins.length || allowedOrigins.some(origin => !/^https:\/\/[a-z0-9.-]+(?::\d+)?$|^http:\/\/localhost(?::\d+)?$|^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin))) {
    throw new Error("Set explicit RUNNER_ALLOWED_ORIGINS (HTTPS or localhost), no wildcard");
  }
  if (repairOperatorsFile !== undefined && repairOperatorsFile !== null &&
      repairOperatorsFile !== "" &&
      (repairOperators !== undefined && repairOperators !== null &&
       repairOperators !== "")) {
    throw new Error("Configure only one repair operator source: JSON or FILE");
  }
  if (repairOperatorsFile &&
      (typeof repairOperatorsFile !== "string" || !path.isAbsolute(repairOperatorsFile) ||
       repairOperatorsFile.includes("\0")))
    throw new Error("RUNNER_REPAIR_OPERATORS_FILE must be an absolute path");
  // Inline source is a legacy startup-only configuration. File source is loaded
  // on every repair request so two API instances can revoke a key immediately.
  const inlineOperatorRegistry = repairOperatorsFile ? null
    : configureRepairOperators(repairOperators, apiKey);
  const recheckRunnerKey = fileMode ? async authorization => {
    const latest = await loadRunnerApiKeyFile(apiKeyFile);
    if (!authenticate(authorization, latest))
      throw Object.assign(new Error("runner_auth_revoked"), { code: "RUNNER_AUTH_REVOKED" });
  } : undefined;
  const recheckTenant = tenantMode ? async (authorization, expectedId) => {
    const latest = authenticateRunnerTenant(authorization,
      await loadRunnerTenantsFile(tenantsFile));
    if (!latest || latest.id !== expectedId)
      throw Object.assign(new Error("tenant_auth_revoked"), { code: "TENANT_AUTH_REVOKED" });
    return latest;
  } : undefined;
  return httpServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = origin && allowedOrigins.includes(origin);
    if (origin && !allowed) {
      res.writeHead(403, { "Content-Type": "application/json" }); res.end('{"error":"origin_not_allowed"}'); return;
    }
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "Vary": "Origin" };
    if (allowed) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, Idempotency-Key";
      headers["Access-Control-Max-Age"] = "600";
    }
    const send = (status, data) => { res.writeHead(status, headers); res.end(JSON.stringify(data)); };
    if (req.method === "OPTIONS") { send(204, {}); return; }
    if (req.url === "/healthz" && req.method === "GET") { send(200, { status: "ok", version: 1 }); return; }
    let activeRunnerKey = apiKey;
    let activeTenant = null;
    if (tenantMode) {
      try {
        activeTenant = authenticateRunnerTenant(req.headers.authorization,
          await loadRunnerTenantsFile(tenantsFile));
      } catch { send(503, { error: "tenant_auth_unavailable" }); return; }
    } else if (fileMode) {
      try { activeRunnerKey = await loadRunnerApiKeyFile(apiKeyFile); }
      catch { send(503, { error: "runner_auth_unavailable" }); return; }
    }
    const repairRoute = (req.url || "").startsWith("/v1/repair-sessions");
    const agentLeaseRoute = req.url === "/v1/agent-task-leases";
    const agentCheckpointRoute = req.url === "/v1/agent-task-checkpoints";
    const agentTestRoute = req.url === "/v1/agent-task-verifications";
    const agentReviewRoute = req.url === "/v1/agent-task-reviews";
    const agentMutationRoute = agentLeaseRoute || agentCheckpointRoute ||
      agentTestRoute || agentReviewRoute;
    if (agentMutationRoute && !agentActorsFile) {
      send(503, { error: "agent_auth_unconfigured" }); return;
    }
    let actorPrincipal=null;
    if (agentMutationRoute) {
      try {
        actorPrincipal=authenticateAgentActor(req.headers.authorization,
          await loadAgentActorsFile(agentActorsFile));
        // Even a misconfigured duplicate secret must never turn a runner
        // admin or tenant bearer into an actor capability.
        if (actorPrincipal && (tenantMode ? Boolean(activeTenant) :
            authenticate(req.headers.authorization,activeRunnerKey)))
          actorPrincipal=null;
      } catch {
        send(503, { error: "agent_auth_unavailable" }); return;
      }
    }
    if (tenantMode && repairRoute) { send(404, { error: "not_found" }); return; }
    if (repairRoute && !repairOperatorsFile && !inlineOperatorRegistry) {
      send(503, { error: "repair_auth_unconfigured" }); return;
    }
    let operatorRegistry = inlineOperatorRegistry;
    if (repairRoute && repairOperatorsFile) {
      try { operatorRegistry = await loadRepairOperatorsFile(repairOperatorsFile, activeRunnerKey); }
      catch {
        send(503, { error: "repair_auth_unavailable" }); return;
      }
    }
    const repairOperator = repairRoute
      ? authenticateRepairOperator(req.headers.authorization, operatorRegistry)
      : null;
    if (agentMutationRoute ? !actorPrincipal : repairRoute ? !repairOperator :
        tenantMode ? !activeTenant : !authenticate(req.headers.authorization, activeRunnerKey)) {
      send(401, { error: "unauthorized" }); return;
    }
    const reauthorizeActorMutation=async()=> {
      await reauthorizeAgentActor(
        agentActorsFile,req.headers.authorization,actorPrincipal);
      // Root and tenant credentials never authorize task checkpoint mutations,
      // including after file-backed key rotation while waiting on a lock.
      if (tenantMode) {
        if (authenticateRunnerTenant(req.headers.authorization,
          await loadRunnerTenantsFile(tenantsFile)))
          throw Object.assign(new Error("shared runner actor credential"),
            {code:"ACTOR_AUTH_REVOKED"});
      } else {
        const latest=fileMode ? await loadRunnerApiKeyFile(apiKeyFile) : apiKey;
        if (authenticate(req.headers.authorization,latest))
          throw Object.assign(new Error("shared runner actor credential"),
            {code:"ACTOR_AUTH_REVOKED"});
      }
    };
    if (req.method === "GET" && req.url === "/v1/host-metrics") {
      // No per-tenant authorization model for global host usage: deny tenant mode.
      if (tenantMode) { send(404, { error: "not_found" }); return; }
      // The API reads only bounded aggregate snapshots from its shared data mount.
      // The worker has Docker access; this process does not. Never read /proc on API.
      try {
        const snapshot = await readWorkerMetrics(dataDir, workerHeartbeatMaxAgeSeconds * 1000);
        send(200, snapshot);
      } catch {
        res.writeHead(503, { ...headers, "Retry-After": "5" });
        res.end(JSON.stringify({ error: "host_metrics_unavailable" }));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/v1/execution-readiness") {
      // API never opens the Docker socket. It verifies the last daemon result
      // measured by the worker, not container execution or remote attestation.
      try {
        await readDockerExecutionReadinessForHttp(dataDir, workerHeartbeatMaxAgeSeconds * 1000);
        send(200, { status: "ready", worker: "responsive", docker: "rootless" });
      } catch {
        res.writeHead(503, { ...headers, "Retry-After": "5" });
        res.end(JSON.stringify({ error: "docker_unavailable" }));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/v1/readiness") {
      // Readiness is not liveness. Do not expose host paths or internal
      // exceptions, and do not claim Docker rootless/SDK/test attestation.
      try {
        await readWorkerHeartbeatForHttp(dataDir, workerHeartbeatMaxAgeSeconds * 1000);
        send(200, { status: "ready", worker: "responsive" });
      } catch {
        res.writeHead(503, { ...headers, "Retry-After": "5" });
        res.end(JSON.stringify({ error: "worker_unavailable" }));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/v1/capabilities") {
      send(200, { protocol: 1, steps: ALLOWED_STEPS, execution: "remote-docker", networkDefault: "none" }); return;
    }
    if (req.method === "GET" && /^\/v1\/jobs\/[a-f0-9-]{36}(?:\/(?:evidence|plan))?$/.test(req.url || "")) {
      try {
        const id = req.url.split("/")[3];
        const verified = await verifyJobEvidenceForRead(dataDir, id);
        if (tenantMode) {
          const latest = await recheckTenant(req.headers.authorization, activeTenant.id);
          if (verified.report.tenantId !== latest.id) {
            send(404, { error: "not_found" }); return;
          }
        } else if (verified.report.tenantId !== undefined) {
          // A deployment accidentally switched back to the legacy key must
          // not silently make all tenant-owned reports visible globally.
          send(404, { error: "not_found" }); return;
        }
        send(200, req.url.endsWith("/evidence")
          ? portableEvidenceBundle(verified)
          : req.url.endsWith("/plan")
            ? projectVerifiedJobPlan(verified) : verified.report);
      } catch(e) {
        // In tenant mode, a corrupt foreign job must not become an existence
        // oracle. Report and evidence corruption still blocks all admissions.
        if (e.code === "EVIDENCE_INVALID")
          tenantMode ? send(404, { error: "not_found" })
            : send(409, { error: "evidence_invalid" });
        else if (e.code === "PM_PLAN_INTEGRITY")
          tenantMode ? send(404, { error: "not_found" })
            : send(409, { error: "plan_integrity" });
        else if (e.code === "ENOENT") send(404, { error: "not_found" });
        else if (e.code === "TENANT_AUTH_REVOKED")
          send(401, { error: "unauthorized" });
        else if (e.code === "TENANT_AUTH_UNAVAILABLE")
          send(503, { error: "tenant_auth_unavailable" });
        else send(500, { error: "read_failure" });
      }
      return;
    }
    // Repair sessions are a checkpoint ledger, not an AI or source-code execution API.
    // Each write is explicitly consented and checked again against verified runner evidence.
    const repairId = /^\/v1\/repair-sessions\/([a-f0-9-]{36})$/.exec(req.url || "");
    if (req.method === "GET" && repairId) {
      try { send(200, await getRepairSession(dataDir, repairId[1])); }
      catch (error) {
        if (error.code === "ENOENT") send(404, { error: "not_found" });
        else if (error.code === "REPAIR_INTEGRITY") send(409, { error: "repair_integrity" });
        else send(500, { error: "internal_error" });
      }
      return;
    }
    const actionRoute = /^\/v1\/repair-sessions\/([a-f0-9-]{36})\/checkpoints$/.exec(req.url || "");
    if (req.method === "POST" && (req.url === "/v1/repair-sessions" || actionRoute)) {
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
        send(415, { error: "json_required" }); return;
      }
      const maxBytes = 4096;
      if (Number(req.headers["content-length"] || 0) > maxBytes) {
        send(413, { error: "too_large" }); req.resume(); return;
      }
      let input;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > maxBytes) { send(413, { error: "too_large" }); return; }
          chunks.push(chunk);
        }
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { send(400, { error: "invalid_json" }); return; }
      const action = actionRoute ? input?.action : "begin";
      if (!mayRecordRepairAction(repairOperator, action)) {
        send(403, { error: "operator_scope_denied" }); return;
      }
      try {
        // Registry may rotate while this request waits for the admission lock.
        // Re-read it at the start of the locked write section, not only here.
        const reauthorize = repairOperatorsFile
          ? async () => {
              const latest = fileMode ? await loadRunnerApiKeyFile(apiKeyFile) : activeRunnerKey;
              await reauthorizeRepairMutation(repairOperatorsFile, latest,
                req.headers.authorization, repairOperator.id, action);
            }
          : undefined;
        const result = actionRoute
          ? await advanceRepairSession(dataDir, actionRoute[1], input,
            repairOperator.id, reauthorize)
          : await beginRepairSession(dataDir, input, repairOperator.id,
            undefined, reauthorize);
        send(actionRoute ? 200 : 201, result);
      } catch (error) {
        const codes = {
          REPAIR_INVALID: [422, "repair_invalid"],
          REPAIR_CONFLICT: [409, "repair_conflict"],
          REPAIR_NOT_FAILED: [409, "repair_not_failed"],
          REPAIR_TRANSITION: [409, "repair_transition"],
          REPAIR_EVIDENCE: [409, "repair_evidence"],
          REPAIR_INTEGRITY: [409, "repair_integrity"],
          REPAIR_CAPACITY: [429, "repair_capacity"],
          REPAIR_ACTOR_CONFLICT: [409, "repair_actor_conflict"],
          REPAIR_LEGACY_READONLY: [409, "repair_legacy_readonly"],
          REPAIR_AUTH_REVOKED: [401, "unauthorized"],
          REPAIR_SCOPE_REVOKED: [403, "operator_scope_denied"],
          REPAIR_AUTH_UNAVAILABLE: [503, "repair_auth_unavailable"],
          RUNNER_AUTH_UNAVAILABLE: [503, "runner_auth_unavailable"],
        };
        if (codes[error.code]) send(codes[error.code][0], { error: codes[error.code][1] });
        else if (error.code === "ENOENT") send(404, { error: "not_found" });
        else if (error.code === "ADMISSION_BUSY") {
          res.writeHead(503, { ...headers, "Retry-After": "2" });
          res.end(JSON.stringify({ error: "admission_busy" }));
        } else send(500, { error: "internal_error" });
      }
      return;
    }



    // Separate actor-scoped capabilities. A runner admin bearer is NOT an
    // agent credential; no lease operation proves execution or completion.
    if (req.method === "POST" && agentLeaseRoute) {
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
        send(415, { error: "json_required" }); return;
      }
      if (Number(req.headers["content-length"] || 0) > 1024) {
        send(413, { error: "too_large" }); req.resume(); return;
      }
      let body;
      try {
        const chunks=[]; let size=0;
        for await (const chunk of req) {
          size+=chunk.length;
          if (size>1024) { send(413,{error:"too_large"}); return; }
          chunks.push(chunk);
        }
        body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { send(400,{error:"invalid_json"}); return; }
      try {
        const result=await mutateAgentTaskLease({
          dataDir,request:body,actor:actorPrincipal,waitMs:admissionWaitMs,
          reauthorize:reauthorizeActorMutation,
        });
        send(200,result);
      } catch(error) {
        if (error.code==="HANDOFF_LEASE_INVALID")
          send(422,{error:"lease_invalid"});
        else if (error.code==="HANDOFF_NOT_FOUND" ||
            error.code==="HANDOFF_INTEGRITY" ||
            error.code==="HANDOFF_TEST_EVIDENCE")
          send(404,{error:"not_found"});
        else if (error.code==="HANDOFF_LEASE_STALE")
          send(409,{error:"lease_stale"});
        else if (error.code==="HANDOFF_LEASE_CONFLICT" ||
            error.code==="HANDOFF_LEASE_COMPLETED")
          send(409,{error:"lease_conflict"});
        else if (error.code==="HANDOFF_LEASE_BLOCKED")
          send(409,{error:"dependency_blocked"});
        else if (error.code==="HANDOFF_LEASE_EXHAUSTED" ||
            error.code==="HANDOFF_LEASE_CAPACITY")
          send(429,{error:"lease_capacity"});
        else if (error.code==="ACTOR_AUTH_REVOKED")
          send(401,{error:"unauthorized"});
        else if (error.code==="ACTOR_AUTH_UNAVAILABLE")
          send(503,{error:"agent_auth_unavailable"});
        else if (error.code==="ADMISSION_BUSY") {
          res.writeHead(503,{...headers,"Retry-After":"2"});
          res.end(JSON.stringify({error:"admission_busy"}));
        } else send(500,{error:"internal_error"});
      }
      return;
    }
    // Manual human approval of a Project Manager artifact digest only.
    // Producer has an active fenced lease; independent approver has an
    // explicit actor capability. It is NEVER a passing technical test.
    if (req.method === "POST" && agentCheckpointRoute) {
      if (req.headers["content-type"]?.split(";")[0].trim()!=="application/json") {
        send(415,{error:"json_required"}); return;
      }
      if (Number(req.headers["content-length"] || 0)>1024) {
        send(413,{error:"too_large"}); req.resume(); return;
      }
      let input;
      try {
        const chunks=[]; let size=0;
        for await(const chunk of req) {
          size+=chunk.length;
          if (size>1024) { send(413,{error:"too_large"}); return; }
          chunks.push(chunk);
        }
        input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { send(400,{error:"invalid_json"}); return; }
      try {
        const result=await mutateAgentTaskCheckpoint({
          dataDir,request:input,actor:actorPrincipal,waitMs:admissionWaitMs,
          reauthorize:reauthorizeActorMutation,
        });
        send(result.created ? 201 : 200,result);
      } catch(error) {
        if (error.code==="HANDOFF_CHECKPOINT_INVALID")
          send(422,{error:"checkpoint_invalid"});
        else if (error.code==="HANDOFF_CHECKPOINT_FORBIDDEN")
          send(403,{error:"actor_scope_denied"});
        else if (error.code==="HANDOFF_NOT_FOUND" ||
            error.code==="HANDOFF_INTEGRITY" ||
            error.code==="HANDOFF_TEST_EVIDENCE")
          send(404,{error:"not_found"});
        else if (error.code==="HANDOFF_CHECKPOINT_CONFLICT")
          send(409,{error:"checkpoint_conflict"});
        else if (error.code==="HANDOFF_CHECKPOINT_BUDGET")
          send(422,{error:"reported_units_exceeded"});
        else if (error.code==="HANDOFF_LEASE_STALE")
          send(409,{error:"lease_stale"});
        else if (error.code==="HANDOFF_LEASE_CAPACITY")
          send(429,{error:"checkpoint_capacity"});
        else if (error.code==="ACTOR_AUTH_REVOKED")
          send(401,{error:"unauthorized"});
        else if (error.code==="ACTOR_AUTH_UNAVAILABLE")
          send(503,{error:"agent_auth_unavailable"});
        else if (error.code==="ADMISSION_BUSY") {
          res.writeHead(503,{...headers,"Retry-After":"2"});
          res.end(JSON.stringify({error:"admission_busy"}));
        } else send(500,{error:"internal_error"});
      }
      return;
    }
    // Independent human inspection of an external review artifact.
    if (req.method === "POST" && agentReviewRoute) {
      if (req.headers["content-type"]?.split(";")[0].trim()!=="application/json") {
        send(415,{error:"json_required"}); return;
      }
      if (Number(req.headers["content-length"] || 0)>1024) {
        send(413,{error:"too_large"}); req.resume(); return;
      }
      let input;
      try {
        const chunks=[]; let bytes=0;
        for await(const chunk of req) {
          bytes+=chunk.length;
          if (bytes>1024) {send(413,{error:"too_large"}); return;}
          chunks.push(chunk);
        }
        input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {send(400,{error:"invalid_json"}); return;}
      try {
        const result=await mutateAgentTaskReview({
          dataDir,request:input,actor:actorPrincipal,
          reauthorize:reauthorizeActorMutation,waitMs:admissionWaitMs,
        });
        send(result.created?201:200,result);
      } catch(error) {
        if(error.code==="HANDOFF_REVIEW_INVALID")
          send(422,{error:"review_invalid"});
        else if(error.code==="HANDOFF_REVIEW_FORBIDDEN")
          send(403,{error:"actor_scope_denied"});
        else if(error.code==="HANDOFF_NOT_FOUND" ||
            error.code==="HANDOFF_INTEGRITY")
          send(404,{error:"not_found"});
        else if(error.code==="HANDOFF_TEST_EVIDENCE" ||
            error.code==="HANDOFF_REVIEW_EVIDENCE")
          send(409,{error:"review_evidence_invalid"});
        else if(error.code==="HANDOFF_REVIEW_CONFLICT")
          send(409,{error:"review_conflict"});
        else if(error.code==="HANDOFF_LEASE_STALE")
          send(409,{error:"lease_stale"});
        else if(error.code==="HANDOFF_LEASE_CAPACITY")
          send(429,{error:"review_capacity"});
        else if(error.code==="ACTOR_AUTH_REVOKED")
          send(401,{error:"unauthorized"});
        else if(error.code==="ACTOR_AUTH_UNAVAILABLE")
          send(503,{error:"agent_auth_unavailable"});
        else if(error.code==="ADMISSION_BUSY") {
          res.writeHead(503,{...headers,"Retry-After":"2"});
          res.end(JSON.stringify({error:"admission_busy"}));
        } else send(500,{error:"internal_error"});
      }
      return;
    }
    // Tester-only completion from actual inode-verified worker journal.
    // Never trust a caller-provided "passed" flag or a PM document digest.
    if (req.method === "POST" && agentTestRoute) {
      if (req.headers["content-type"]?.split(";")[0].trim()!=="application/json") {
        send(415,{error:"json_required"}); return;
      }
      if (Number(req.headers["content-length"] || 0)>1024) {
        send(413,{error:"too_large"}); req.resume(); return;
      }
      let input;
      try {
        const chunks=[]; let bytes=0;
        for await(const chunk of req) {
          bytes+=chunk.length;
          if (bytes>1024) { send(413,{error:"too_large"}); return; }
          chunks.push(chunk);
        }
        input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { send(400,{error:"invalid_json"}); return; }
      try {
        const result=await verifyAgentTestTask({
          dataDir,request:input,actor:actorPrincipal,waitMs:admissionWaitMs,
          reauthorize:reauthorizeActorMutation,
        });
        send(result.created?201:200,result);
      } catch(error) {
        if (error.code==="HANDOFF_TEST_INVALID")
          send(422,{error:"test_verification_invalid"});
        else if (error.code==="HANDOFF_TEST_FORBIDDEN")
          send(403,{error:"actor_scope_denied"});
        else if (error.code==="HANDOFF_NOT_FOUND" ||
            error.code==="HANDOFF_INTEGRITY")
          send(404,{error:"not_found"});
        else if (error.code==="HANDOFF_TEST_EVIDENCE")
          send(409,{error:"test_evidence_invalid"});
        else if (error.code==="HANDOFF_TEST_CONFLICT")
          send(409,{error:"test_verification_conflict"});
        else if (error.code==="HANDOFF_LEASE_STALE")
          send(409,{error:"lease_stale"});
        else if (error.code==="HANDOFF_LEASE_CAPACITY")
          send(429,{error:"verification_capacity"});
        else if (error.code==="ACTOR_AUTH_REVOKED")
          send(401,{error:"unauthorized"});
        else if (error.code==="ACTOR_AUTH_UNAVAILABLE")
          send(503,{error:"agent_auth_unavailable"});
        else if (error.code==="ADMISSION_BUSY") {
          res.writeHead(503,{...headers,"Retry-After":"2"});
          res.end(JSON.stringify({error:"admission_busy"}));
        } else send(500,{error:"internal_error"});
      }
      return;
    }
    // Operator-authorized DECLARATION of an AI handoff DAG. No agent task
    // claims, execution or auto approval can occur on these endpoints.
    const handoffId = /^\/v1\/agent-handoffs\/([a-f0-9-]{36})$/.exec(req.url || "");
    if (req.method === "GET" && handoffId) {
      try {
        const result = await getAgentHandoff(dataDir,handoffId[1],
          activeTenant?.id ?? null,
          tenantMode ? () => recheckTenant(req.headers.authorization,activeTenant.id)
            : recheckRunnerKey ? () => recheckRunnerKey(req.headers.authorization) : undefined);
        send(200,result);
      } catch(error) {
        if (error.code === "HANDOFF_NOT_FOUND" || error.code === "ENOENT")
          send(404,{error:"not_found"});
        else if (error.code === "HANDOFF_INTEGRITY" ||
                 error.code === "HANDOFF_TEST_EVIDENCE")
          tenantMode ? send(404,{error:"not_found"}) : send(409,{error:"handoff_integrity"});
        else if (error.code === "TENANT_AUTH_REVOKED" || error.code === "RUNNER_AUTH_REVOKED")
          send(401,{error:"unauthorized"});
        else if (error.code === "TENANT_AUTH_UNAVAILABLE" || error.code === "RUNNER_AUTH_UNAVAILABLE")
          send(503,{error:"runner_auth_unavailable"});
        else send(500,{error:"internal_error"});
      }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/agent-handoffs") {
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
        send(415,{error:"json_required"}); return;
      }
      if (Number(req.headers["content-length"] || 0) > MAX_HANDOFF_BODY_BYTES) {
        send(413,{error:"too_large"}); req.resume(); return;
      }
      let input;
      try {
        const chunks=[]; let length=0;
        for await (const chunk of req) {
          length+=chunk.length;
          if (length > MAX_HANDOFF_BODY_BYTES) {
            send(413,{error:"too_large"}); return;
          }
          chunks.push(chunk);
        }
        input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { send(400,{error:"invalid_json"}); return; }
      try {
        const result=await registerAgentHandoff({
          dataDir,input,idempotencyKey:req.headers["idempotency-key"],
          tenantId:activeTenant?.id ?? null,waitMs:admissionWaitMs,
          reauthorize:tenantMode
            ? () => recheckTenant(req.headers.authorization,activeTenant.id)
            : recheckRunnerKey ? () => recheckRunnerKey(req.headers.authorization) : undefined,
        });
        send(result.created ? 201 : 200,result);
      } catch(error) {
        if (error.code === "HANDOFF_INVALID" || error.code === "INVALID_IDEMPOTENCY_KEY")
          send(422,{error:"handoff_invalid"});
        else if (error.code === "HANDOFF_BUDGET")
          send(422,{error:"budget_exceeded"});
        else if (error.code === "HANDOFF_CONFLICT")
          send(409,{error:"handoff_conflict"});
        else if (error.code === "HANDOFF_CAPACITY")
          send(429,{error:"handoff_capacity"});
        else if (error.code === "HANDOFF_INTEGRITY" ||
                 error.code === "HANDOFF_TEST_EVIDENCE")
          tenantMode ? send(404,{error:"not_found"}) : send(409,{error:"handoff_integrity"});
        else if (error.code === "ADMISSION_BUSY") {
          res.writeHead(503,{...headers,"Retry-After":"2"});
          res.end(JSON.stringify({error:"admission_busy"}));
        } else if (error.code === "TENANT_AUTH_REVOKED" || error.code === "RUNNER_AUTH_REVOKED")
          send(401,{error:"unauthorized"});
        else if (error.code === "TENANT_AUTH_UNAVAILABLE" || error.code === "RUNNER_AUTH_UNAVAILABLE")
          send(503,{error:"runner_auth_unavailable"});
        else send(500,{error:"internal_error"});
      }
      return;
    }
    // Operator-consented, immutable cross-job dependency manifest. No job
    // scheduling or source code execution is permitted through these routes.
    const workflowId = /^\/v1\/workflows\/([a-f0-9-]{36})$/.exec(req.url || "");
    if (req.method === "GET" && workflowId) {
      try {
        const result = await getWorkflow(dataDir, workflowId[1],
          activeTenant?.id ?? null, tenantMode
            ? () => recheckTenant(req.headers.authorization, activeTenant.id)
            : recheckRunnerKey ? () => recheckRunnerKey(req.headers.authorization) : undefined);
        send(200, result);
      } catch (error) {
        if (error.code === "WORKFLOW_NOT_FOUND" || error.code === "ENOENT")
          send(404, { error: "not_found" });
        else if (error.code === "WORKFLOW_EVIDENCE" || error.code === "WORKFLOW_INTEGRITY")
          tenantMode ? send(404, { error: "not_found" }) : send(409, { error: "workflow_integrity" });
        else if (error.code === "TENANT_AUTH_REVOKED" || error.code === "RUNNER_AUTH_REVOKED")
          send(401, { error: "unauthorized" });
        else if (error.code === "TENANT_AUTH_UNAVAILABLE" || error.code === "RUNNER_AUTH_UNAVAILABLE")
          send(503, { error: "runner_auth_unavailable" });
        else send(500, { error: "internal_error" });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/v1/workflows/batch") {
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
        send(415, { error: "json_required" }); return;
      }
      if (Number(req.headers["content-length"] || 0) > MAX_BATCH_BODY_BYTES) {
        send(413, { error: "too_large" }); req.resume(); return;
      }
      let input;
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BATCH_BODY_BYTES) { send(413, { error: "too_large" }); return; }
          chunks.push(chunk);
        }
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { send(400, { error: "invalid_json" }); return; }
      try {
        const result = await admitWorkflowBatch({
          dataDir, input, idempotencyKey: req.headers["idempotency-key"],
          maxQueued, maxRetained, maxAcceptedPerMinute, waitMs: admissionWaitMs,
          tenant: activeTenant,
          reauthorize: tenantMode
            ? () => recheckTenant(req.headers.authorization, activeTenant.id)
            : recheckRunnerKey
              ? () => recheckRunnerKey(req.headers.authorization) : undefined,
        });
        send(result.created ? 201 : 200, result);
      } catch (e) {
        if (e.code === "WORKFLOW_INVALID" || e.code === "INVALID_IDEMPOTENCY_KEY")
          send(422, { error: "workflow_invalid" });
        else if (e.code === "WORKFLOW_CONFLICT")
          send(409, { error: "workflow_conflict" });
        else if (e.code === "QUEUE_FULL")
          send(429, { error: "queue_full" });
        else if (e.code === "RATE_LIMIT") {
          res.writeHead(429, { ...headers, "Retry-After": String(e.retryAfter) });
          res.end(JSON.stringify({ error: "rate_limited" }));
        } else if (e.code === "WORKFLOW_CAPACITY")
          send(429, { error: "workflow_capacity" });
        else if (e.code === "WORKFLOW_INTEGRITY" || e.code === "WORKFLOW_EVIDENCE")
          tenantMode ? send(404, { error: "not_found" })
            : send(409, { error: "workflow_integrity" });
        else if (e.code === "ADMISSION_BUSY" || e.code === "ADMISSION_INTEGRITY") {
          res.writeHead(503, { ...headers, "Retry-After": "2" });
          res.end(JSON.stringify({ error: "admission_unavailable" }));
        } else if (e.code === "TENANT_AUTH_REVOKED" || e.code === "RUNNER_AUTH_REVOKED")
          send(401, { error: "unauthorized" });
        else if (e.code === "TENANT_AUTH_UNAVAILABLE" || e.code === "RUNNER_AUTH_UNAVAILABLE")
          send(503, { error: "runner_auth_unavailable" });
        else send(500, { error: "internal_error" });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/workflows") {
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
        send(415, { error: "json_required" }); return;
      }
      if (Number(req.headers["content-length"] || 0) > 4096) {
        send(413, { error: "too_large" }); req.resume(); return;
      }
      let input;
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 4096) { send(413, { error: "too_large" }); return; }
          chunks.push(chunk);
        }
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { send(400, { error: "invalid_json" }); return; }
      try {
        const result = await registerWorkflow({ dataDir, input,
          tenantId: activeTenant?.id ?? null,
          idempotencyKey: req.headers["idempotency-key"],
          reauthorize: tenantMode
            ? () => recheckTenant(req.headers.authorization, activeTenant.id)
            : recheckRunnerKey ? () => recheckRunnerKey(req.headers.authorization) : undefined });
        send(result.created ? 201 : 200, result);
      } catch (error) {
        if (error.code === "WORKFLOW_INVALID" || error.code === "INVALID_IDEMPOTENCY_KEY")
          send(422, { error: "workflow_invalid" });
        else if (error.code === "WORKFLOW_CONFLICT")
          send(409, { error: "workflow_conflict" });
        else if (error.code === "WORKFLOW_NOT_QUEUED")
          send(409, { error: "workflow_not_queued" });
        else if (error.code === "WORKFLOW_NOT_FOUND")
          send(404, { error: "not_found" });
        else if (error.code === "WORKFLOW_EVIDENCE" || error.code === "WORKFLOW_INTEGRITY")
          tenantMode ? send(404, { error: "not_found" }) : send(409, { error: "workflow_integrity" });
        else if (error.code === "WORKFLOW_CAPACITY")
          send(429, { error: "workflow_capacity" });
        else if (error.code === "ADMISSION_BUSY") {
          res.writeHead(503, { ...headers, "Retry-After": "2" });
          res.end(JSON.stringify({ error: "admission_busy" }));
        } else if (error.code === "TENANT_AUTH_REVOKED" || error.code === "RUNNER_AUTH_REVOKED")
          send(401, { error: "unauthorized" });
        else if (error.code === "TENANT_AUTH_UNAVAILABLE" || error.code === "RUNNER_AUTH_UNAVAILABLE")
          send(503, { error: "runner_auth_unavailable" });
        else send(500, { error: "internal_error" });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/jobs") {
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") { send(415, { error: "json_required" }); return; }
      const declared = Number(req.headers["content-length"] || 0);
      if (declared > MAX_REQUEST_BYTES) { send(413, { error: "too_large" }); req.resume(); return; }
      try {
        const chunks = []; let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > MAX_REQUEST_BYTES) { send(413, { error: "too_large" }); return; }
          chunks.push(chunk);
        }
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { send(400, { error: "invalid_json" }); return; }
        let checked;
        try { checked = validateRequest(parsed); }
        catch(e) { send(422, { error: "invalid_request", detail: e.message }); return; }
        try {
          const receipt = await admitRunnerJob({
            dataDir, checked, idempotencyKey: req.headers["idempotency-key"],
            maxQueued, maxRetained, waitMs: admissionWaitMs, maxAcceptedPerMinute,
            tenant: activeTenant,
            reauthorize: tenantMode
              ? () => recheckTenant(req.headers.authorization, activeTenant.id)
              : recheckRunnerKey
                ? () => recheckRunnerKey(req.headers.authorization) : undefined,
          });
          send(202, receipt);
        } catch (error) {
          if (error.code === "INVALID_IDEMPOTENCY_KEY")
            send(422, { error: "invalid_idempotency_key" });
          else if (error.code === "TENANT_AUTH_REVOKED")
            send(401, { error: "unauthorized" });
          else if (error.code === "TENANT_AUTH_UNAVAILABLE")
            send(503, { error: "tenant_auth_unavailable" });
          else if (error.code === "RUNNER_AUTH_REVOKED")
            send(401, { error: "unauthorized" });
          else if (error.code === "RUNNER_AUTH_UNAVAILABLE")
            send(503, { error: "runner_auth_unavailable" });
          else if (error.code === "IDEMPOTENCY_CONFLICT")
            send(409, { error: "idempotency_conflict" });
          else if (error.code === "QUEUE_FULL")
            send(429, { error: "queue_full" });
          else if (error.code === "RATE_LIMIT") {
            res.writeHead(429, { ...headers, "Retry-After": String(error.retryAfter) });
            res.end(JSON.stringify({ error: "rate_limited" }));
          } else if (error.code === "ADMISSION_BUSY" || error.code === "ADMISSION_INTEGRITY") {
            res.writeHead(503, { ...headers, "Retry-After": "2" });
            res.end(JSON.stringify({ error: error.code === "ADMISSION_BUSY" ?
              "admission_busy" : "admission_integrity" }));
          } else send(500, { error: "internal_error" });
        }
      } catch { send(500, { error: "internal_error" }); }
      return;
    }
    send(404, { error: "not_found" });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.RUNNER_PORT || "8787");
  const server = createRunnerServer();
  server.listen(port, "0.0.0.0", () => console.log("Runner API listening on port " + port));
}
