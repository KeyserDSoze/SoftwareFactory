import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const RUNNER_PROTOCOL = 1;
export const ALLOWED_STEPS = Object.freeze(["dotnet-build", "dotnet-test", "web-build", "web-test", "playwright"]);
export const MAX_REQUEST_BYTES = 1_500_000;
export const MAX_FILES = 160;
export const MAX_FILE_BYTES = 100_000;
export const MAX_TOTAL_BYTES = 1_100_000;
const SECRET_MARKERS = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[a-zA-Z0-9_]{15,}|gh[pousr]_[a-zA-Z0-9]{20,}/;
const allowed = [
  /^src\/backend\/(?:applications\/Api|business|domain|infrastructure)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:cs|csproj|json)$/,
  /^src\/frontend\/web\/(?:src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:ts|tsx|css)|(?:index\.html|package\.json|package-lock\.json|vite\.config\.ts|tsconfig\.json|playwright\.config\.ts)|e2e\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.spec\.ts)$/,
  /^tests\/backend\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:cs|csproj|json)$/,
];
export function isAllowedFile(name) {
  return typeof name === "string" && name.length <= 180 && name.length > 0 &&
    !name.includes("..") && !name.includes("//") && !name.includes("\\") &&
    !name.startsWith("/") && !/[\x00-\x1f\x7f]/.test(name) &&
    !name.split("/").some(segment => segment.startsWith(".")) &&
    allowed.some(pattern => pattern.test(name));
}
export function validateRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Request must be an object");
  const label = raw.label;
  if (typeof label !== "string" || label.length > 160 || !label.trim()) throw new Error("Invalid job label");
  const files = raw.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("files must be an object");
  const entries = Object.entries(files);
  if (!entries.length || entries.length > MAX_FILES) throw new Error("Invalid file count");
  let bytes = 0;
  for (const [name, content] of entries) {
    if (!isAllowedFile(name)) throw new Error("File path not permitted: " + String(name).slice(0, 180));
    if (typeof content !== "string" || content.length > MAX_FILE_BYTES)
      throw new Error("Invalid file contents: " + name);
    bytes += Buffer.byteLength(content, "utf8");
    if (bytes > MAX_TOTAL_BYTES) throw new Error("Workspace is too large");
    if (SECRET_MARKERS.test(content)) throw new Error("Potential credential found in submitted file");
  }
  if (!Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > ALLOWED_STEPS.length ||
      raw.steps.some(s => !ALLOWED_STEPS.includes(s)) || new Set(raw.steps).size !== raw.steps.length)
    throw new Error("Unknown or duplicated test step");
  const sortedFiles = Object.fromEntries(entries.sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0));
  const request = { schemaVersion: RUNNER_PROTOCOL, label: label.trim(), files: sortedFiles, steps: [...raw.steps] };
  const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  return { request, digest, fileCount: entries.length, bytes };
}
export function authenticate(header, secret) {
  if (typeof header !== "string" || !header.startsWith("Bearer ") || typeof secret !== "string" || secret.length < 32) return false;
  const provided = Buffer.from(createHash("sha256").update(header.slice(7)).digest());
  const expected = Buffer.from(createHash("sha256").update(secret).digest());
  return timingSafeEqual(provided, expected);
}
export function jobId() { return randomUUID(); }
export function jobDirectory(root, id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid job identifier");
  return path.resolve(root, "jobs", id);
}
export async function readReport(root, id) {
  const report = JSON.parse(await readFile(path.join(jobDirectory(root, id), "report.json"), "utf8"));
  return report;
}
export async function atomicWrite(file, value) {
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, file);
}
export function scrub(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/github_pat_[a-zA-Z0-9_]{15,}/g, "[REDACTED]")
    .replace(/gh[pousr]_[a-zA-Z0-9]{20,}/g, "[REDACTED]")
    .replace(/(api[_-]?key|password|secret|token)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(-9000);
}
