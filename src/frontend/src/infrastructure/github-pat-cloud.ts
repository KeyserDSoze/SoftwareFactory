/** GitHub PAT E2EE in the provider's private app folder. Token is encrypted
 * locally before upload. OneDrive enforces If-Match; Google uses version checks
 * and detects duplicates, but Drive v3 has no dependable exposed CAS token.
 */
import type { CloudConfig } from "../domain/types";
import { readSecret } from "./store";
import { encryptGithubPatCloud, decryptGithubPatCloud,
  validateGithubPatVault } from "./github-pat-cloud-crypto";
const FILE = "softwarefactory-github-pat-v1.json";
type Locator = { url: string; id: string | null; version: string | null; etag: string | null };
function cloudToken(config: CloudConfig): string {
  const token = readSecret("cloud." + config.provider);
  if (!token) throw Error("Collega Google Drive o OneDrive prima di usare il vault PAT.");
  return token;
}
async function call(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const r = await fetch(url, { ...init, mode: "cors", credentials: "omit", redirect: "error",
    referrerPolicy: "no-referrer", cache: "no-store",
    headers: { Authorization: "Bearer " + token, ...init.headers } });
  if (!r.ok) {
    if (r.status === 409 || r.status === 412) throw Error("Vault PAT modificato da un altro dispositivo: rileggi prima di salvare.");
    throw Error("Cloud PAT vault HTTP " + r.status + ". Controlla OAuth e autorizzazioni.");
  }
  return r;
}
async function locate(config: CloudConfig, token: string): Promise<Locator> {
  if (config.provider === "microsoft") {
    const url = "https://graph.microsoft.com/v1.0/me/drive/special/approot:/" + FILE;
    const r = await fetch(url, { mode: "cors", credentials: "omit", redirect: "error",
      cache: "no-store", headers: { Authorization: "Bearer " + token } });
    if (r.status === 404) return { url: url + ":/content", id: null, version: null, etag: null };
    if (!r.ok) throw Error("Metadata vault PAT Microsoft HTTP " + r.status + ".");
    const v: unknown = await r.json();
    if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("Metadata OneDrive PAT non validi.");
    const etag = (v as Record<string, unknown>).eTag;
    if (typeof etag !== "string" || etag.length < 3 || etag.length > 256 ||
        /[\r\n]/.test(etag)) throw Error("OneDrive non ha restituito ETag per proteggere il vault.");
    return { url: url + ":/content", id: "existing", version: null, etag };
  }
  const query = new URLSearchParams({ spaces: "appDataFolder",
    q: "name = '" + FILE + "' and trashed = false",
    fields: "files(id,name,version)", pageSize: "10" });
  const res = await call("https://www.googleapis.com/drive/v3/files?" + query, token);
  const data: unknown = await res.json();
  if (!data || typeof data !== "object" || !Array.isArray((data as {files?: unknown}).files) ||
      (data as { files: unknown[] }).files.length > 10) throw Error("Elenco vault PAT Drive non valido.");
  const files = (data as { files: unknown[] }).files;
  if (files.length > 1) throw Error("Più vault PAT con lo stesso nome su Google Drive: risolvere manualmente.");
  if (files.length === 0) return { url: "", id: null, version: null, etag: null };
  const entry = files[0] as { id?: unknown; version?: unknown; name?: unknown };
  if (!entry || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{8,200}$/.test(entry.id) ||
      entry.name !== FILE || (typeof entry.version !== "string" && typeof entry.version !== "number"))
    throw Error("Versione/riferimento vault PAT Drive non valido.");
  const version = String(entry.version);
  if (!/^\d{1,19}$/.test(version)) throw Error("Versione vault PAT Drive non valida.");
  return { id: entry.id, url: "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(entry.id) + "?alt=media", version, etag: null };
}
async function readExisting(location: Locator, config: CloudConfig, token: string): Promise<string> {
  const r = await call(location.url, token);
  const raw = await r.text();
  if (raw.length > 8192) throw Error("Vault PAT cloud troppo grande.");
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { throw Error("Vault PAT cloud non valido."); }
  return JSON.stringify(validateGithubPatVault(payload));
}
export async function restoreGithubPatFromCloud(
  config: CloudConfig, passphrase: string,
): Promise<string> {
  const token = cloudToken(config);
  const location = await locate(config, token);
  if (!location.id) throw Error("Nessun vault GitHub PAT presente nell'app folder.");
  return decryptGithubPatCloud(JSON.parse(await readExisting(location, config, token)), passphrase);
}
export async function saveGithubPatToCloud(
  config: CloudConfig, pat: string, passphrase: string,
): Promise<void> {
  const token = cloudToken(config);
  // Encryption MUST happen before requests that send any data to cloud.
  const cipher = JSON.stringify(await encryptGithubPatCloud(pat, passphrase));
  const location = await locate(config, token);
  if (location.id) {
    // Require existing cloud copy to be decryptable with the same phrase;
    // prevents silent destruction of another device's unknown credential.
    const previous = JSON.parse(await readExisting(location, config, token));
    await decryptGithubPatCloud(previous, passphrase);
  }
  if (config.provider === "microsoft") {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (location.etag) headers["If-Match"] = location.etag;
    else headers["If-None-Match"] = "*";
    await call(location.url, token, { method: "PUT", headers, body: cipher });
    return;
  }
  if (location.id) {
    // Two reads catch stale devices, but not a concurrent write between
    // second metadata read and PATCH. Do not call this strong atomic CAS.
    const current = await locate(config, token);
    if (current.id !== location.id || current.version !== location.version)
      throw Error("Vault PAT cambiato su Google Drive: apri la versione nuova prima di sovrascrivere.");
    await call("https://www.googleapis.com/upload/drive/v3/files/" +
      encodeURIComponent(location.id) + "?uploadType=media", token, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: cipher,
    });
  } else {
    // A concurrent create can result in two appDataFolder entries. The next
    // load detects and refuses ambiguity rather than choosing the newest.
    const boundary = "sfpat_" + crypto.randomUUID().replace(/-/g, "");
    const body = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify({ name: FILE, parents: ["appDataFolder"], mimeType: "application/json" }) +
      "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" +
      cipher + "\r\n--" + boundary + "--";
    await call("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", token,
      { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body });
  }
}
