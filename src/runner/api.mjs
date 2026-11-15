import { createServer as httpServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ALLOWED_STEPS, MAX_REQUEST_BYTES, authenticate, validateRequest } from "./common.mjs";
import { portableEvidenceBundle, verifyJobEvidence } from "./evidence.mjs";
import { admitRunnerJob } from "./admission.mjs";

export function createRunnerServer({
  apiKey = process.env.RUNNER_API_KEY,
  allowedOrigins = (process.env.RUNNER_ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean),
  dataDir = process.env.RUNNER_DATA_DIR || "/data",
  maxQueued = Number(process.env.RUNNER_MAX_QUEUED || 4),
  maxRetained = 100,
  admissionWaitMs = 1500,
} = {}) {
  if (typeof apiKey !== "string" || apiKey.length < 32) throw new Error("RUNNER_API_KEY must contain at least 32 characters");
  if (!allowedOrigins.length || allowedOrigins.some(origin => !/^https:\/\/[a-z0-9.-]+(?::\d+)?$|^http:\/\/localhost(?::\d+)?$|^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin))) {
    throw new Error("Set explicit RUNNER_ALLOWED_ORIGINS (HTTPS or localhost), no wildcard");
  }
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
    if (!authenticate(req.headers.authorization, apiKey)) { send(401, { error: "unauthorized" }); return; }
    if (req.method === "GET" && req.url === "/v1/capabilities") {
      send(200, { protocol: 1, steps: ALLOWED_STEPS, execution: "remote-docker", networkDefault: "none" }); return;
    }
    if (req.method === "GET" && /^\/v1\/jobs\/[a-f0-9-]{36}(?:\/evidence)?$/.test(req.url || "")) {
      try {
        const id = req.url.split("/")[3];
        const verified = await verifyJobEvidence(dataDir, id);
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
            maxQueued, maxRetained, waitMs: admissionWaitMs,
          });
          send(202, receipt);
        } catch (error) {
          if (error.code === "INVALID_IDEMPOTENCY_KEY")
            send(422, { error: "invalid_idempotency_key" });
          else if (error.code === "IDEMPOTENCY_CONFLICT")
            send(409, { error: "idempotency_conflict" });
          else if (error.code === "QUEUE_FULL")
            send(429, { error: "queue_full" });
          else if (error.code === "ADMISSION_BUSY" || error.code === "ADMISSION_INTEGRITY") {
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
