import { createServer as httpServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ALLOWED_STEPS, MAX_REQUEST_BYTES, authenticate, validateRequest } from "./common.mjs";
import { portableEvidenceBundle, verifyJobEvidenceForRead } from "./evidence.mjs";
import { admitRunnerJob } from "./admission.mjs";
import { beginRepairSession, getRepairSession, advanceRepairSession } from "./coordinator.mjs";
import { configureRepairOperators, loadRepairOperatorsFile, authenticateRepairOperator, mayRecordRepairAction, reauthorizeRepairMutation } from "./operator-auth.mjs";

export function createRunnerServer({
  apiKey = process.env.RUNNER_API_KEY,
  allowedOrigins = (process.env.RUNNER_ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean),
  dataDir = process.env.RUNNER_DATA_DIR || "/data",
  maxQueued = Number(process.env.RUNNER_MAX_QUEUED || 4),
  maxAcceptedPerMinute = Number(process.env.RUNNER_MAX_ACCEPTED_PER_MINUTE ?? 0),
  maxRetained = 100,
  admissionWaitMs = 1500,
  repairOperators = process.env.RUNNER_REPAIR_OPERATORS_JSON,
  repairOperatorsFile = process.env.RUNNER_REPAIR_OPERATORS_FILE,
} = {}) {
  if (typeof apiKey !== "string" || apiKey.length < 32) throw new Error("RUNNER_API_KEY must contain at least 32 characters");
  if (!Number.isInteger(maxAcceptedPerMinute) ||
      maxAcceptedPerMinute < 0 || maxAcceptedPerMinute > 100)
    throw new Error("RUNNER_MAX_ACCEPTED_PER_MINUTE must be an integer between 0 and 100");
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
    const repairRoute = (req.url || "").startsWith("/v1/repair-sessions");
    if (repairRoute && !repairOperatorsFile && !inlineOperatorRegistry) {
      send(503, { error: "repair_auth_unconfigured" }); return;
    }
    let operatorRegistry = inlineOperatorRegistry;
    if (repairRoute && repairOperatorsFile) {
      try { operatorRegistry = await loadRepairOperatorsFile(repairOperatorsFile, apiKey); }
      catch {
        send(503, { error: "repair_auth_unavailable" }); return;
      }
    }
    const repairOperator = repairRoute
      ? authenticateRepairOperator(req.headers.authorization, operatorRegistry)
      : null;
    if (repairRoute ? !repairOperator : !authenticate(req.headers.authorization, apiKey)) {
      send(401, { error: "unauthorized" }); return;
    }
    if (req.method === "GET" && req.url === "/v1/capabilities") {
      send(200, { protocol: 1, steps: ALLOWED_STEPS, execution: "remote-docker", networkDefault: "none" }); return;
    }
    if (req.method === "GET" && /^\/v1\/jobs\/[a-f0-9-]{36}(?:\/evidence)?$/.test(req.url || "")) {
      try {
        const id = req.url.split("/")[3];
        const verified = await verifyJobEvidenceForRead(dataDir, id);
        send(200, req.url.endsWith("/evidence")
          ? portableEvidenceBundle(verified)
          : verified.report);
      } catch(e) {
        if (e.code === "EVIDENCE_INVALID") send(409, { error: "evidence_invalid" });
        else if (e.code === "ENOENT") send(404, { error: "not_found" });
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
          ? () => reauthorizeRepairMutation(repairOperatorsFile, apiKey,
            req.headers.authorization, repairOperator.id, action)
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
          });
          send(202, receipt);
        } catch (error) {
          if (error.code === "INVALID_IDEMPOTENCY_KEY")
            send(422, { error: "invalid_idempotency_key" });
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
