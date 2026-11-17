import type { CloudConfig, FactoryProject, FactorySettings } from "../domain/types";
import { persistSettings, readSecret, saveSecret } from "./store";
import { encryptRunnerCredential, decryptRunnerCredential, validateRunnerVault } from "./runner-vault";

const OAUTH_STATE = "softwarefactory.oauth.state";
const OAUTH_VERIFIER = "softwarefactory.oauth.verifier";
const OAUTH_PROVIDER = "softwarefactory.oauth.provider";
const SNAPSHOT_NAME = "softwarefactory-state.json";
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function redirectUri(): string { return location.origin + location.pathname; }

export async function startCloudLogin(config: CloudConfig): Promise<void> {
  if (!config.clientId.trim()) throw new Error("Configura un OAuth Client ID per " + config.provider + ".");
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = base64url(bytes);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = crypto.randomUUID();
  sessionStorage.setItem(OAUTH_STATE, state);
  sessionStorage.setItem(OAUTH_VERIFIER, verifier);
  sessionStorage.setItem(OAUTH_PROVIDER, config.provider);
  const google = config.provider === "google";
  const url = new URL(google ? "https://accounts.google.com/o/oauth2/v2/auth" : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  const params: Record<string, string> = {
    client_id: config.clientId, redirect_uri: redirectUri(), response_type: "code",
    scope: google ? "https://www.googleapis.com/auth/drive.appdata" : "Files.ReadWrite.AppFolder User.Read",
    state, code_challenge: base64url(hash), code_challenge_method: "S256",
  };
  if (google) params.access_type = "online";
  else params.response_mode = "query";
  url.search = new URLSearchParams(params).toString();
  location.assign(url.href);
}
export async function finishCloudLogin(config: CloudConfig): Promise<boolean> {
  const url = new URL(location.href);
  if (!url.searchParams.has("code") && !url.searchParams.has("error")) return false;
  const state = sessionStorage.getItem(OAUTH_STATE);
  const verifier = sessionStorage.getItem(OAUTH_VERIFIER);
  const provider = sessionStorage.getItem(OAUTH_PROVIDER);
  if (!state || !verifier || url.searchParams.get("state") !== state || provider !== config.provider) {
    throw new Error("OAuth state non valido: accesso annullato.");
  }
  sessionStorage.removeItem(OAUTH_STATE);
  sessionStorage.removeItem(OAUTH_VERIFIER);
  sessionStorage.removeItem(OAUTH_PROVIDER);
  const error = url.searchParams.get("error");
  if (error) throw new Error("Accesso cloud rifiutato: " + error);
  const endpoint = provider === "google" ? "https://oauth2.googleapis.com/token" : "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, code: url.searchParams.get("code") || "", code_verifier: verifier, redirect_uri: redirectUri(), grant_type: "authorization_code" }),
  });
  if (!response.ok) throw new Error("Scambio token cloud fallito: HTTP " + response.status);
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error("Token cloud non restituito.");
  saveSecret("cloud." + provider, data.access_token);
  url.searchParams.delete("code"); url.searchParams.delete("state"); url.searchParams.delete("session_state");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  return true;
}
async function cloudFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const r = await fetch(url, { ...init, headers: { Authorization: "Bearer " + token, ...init.headers }, redirect: "follow" });
  if (!r.ok) throw new Error("Cloud API HTTP " + r.status + " (verifica OAuth scope e permessi).");
  return r;
}
export async function backupCloud(project: FactoryProject, settings: FactorySettings): Promise<void> {
  const provider = settings.cloud.provider;
  const token = readSecret("cloud." + provider);
  if (!token) throw new Error("Connetti prima " + (provider === "google" ? "Google Drive" : "OneDrive") + ".");
  const safeSettings: FactorySettings = { ...settings, git: { ...settings.git, appGateway: settings.git.appGateway } };
  const payload = JSON.stringify({ schemaVersion: 1, project, settings: safeSettings, savedAt: new Date().toISOString() });
  if (provider === "microsoft") {
    await cloudFetch("https://graph.microsoft.com/v1.0/me/drive/special/approot:/" + SNAPSHOT_NAME + ":/content", token, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: payload,
    });
    return;
  }
  const listUrl = new URL("https://www.googleapis.com/drive/v3/files");
  listUrl.search = new URLSearchParams({ spaces: "appDataFolder", q: "name = '" + SNAPSHOT_NAME + "' and trashed = false", fields: "files(id,name)", pageSize: "10" }).toString();
  const list = await (await cloudFetch(listUrl.href, token)).json() as { files?: { id: string }[] };
  if (list.files?.[0]?.id) {
    await cloudFetch("https://www.googleapis.com/upload/drive/v3/files/" + encodeURIComponent(list.files[0].id) + "?uploadType=media", token, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: payload,
    });
    return;
  }
  const boundary = "factory_" + crypto.randomUUID().replace(/-/g, "");
  const content = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify({ name: SNAPSHOT_NAME, parents: ["appDataFolder"], mimeType: "application/json" }) +
    "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + payload + "\r\n--" + boundary + "--";
  await cloudFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", token, {
    method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body: content,
  });
}
export async function restoreCloud(settings: FactorySettings): Promise<{ project: FactoryProject; settings?: FactorySettings }> {
  const provider = settings.cloud.provider;
  const token = readSecret("cloud." + provider);
  if (!token) throw new Error("Accesso cloud non attivo.");
  let url: string;
  if (provider === "microsoft") url = "https://graph.microsoft.com/v1.0/me/drive/special/approot:/" + SNAPSHOT_NAME + ":/content";
  else {
    const listUrl = new URL("https://www.googleapis.com/drive/v3/files");
    listUrl.search = new URLSearchParams({ spaces: "appDataFolder", q: "name = '" + SNAPSHOT_NAME + "' and trashed = false", fields: "files(id,name)" }).toString();
    const list = await (await cloudFetch(listUrl.href, token)).json() as { files?: { id: string }[] };
    if (!list.files?.[0]?.id) throw new Error("Nessun backup SoftwareFactory su Google Drive.");
    url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(list.files[0].id) + "?alt=media";
  }
  const data: unknown = await (await cloudFetch(url, token)).json();
  if (!data || typeof data !== "object" || !("schemaVersion" in data) || data.schemaVersion !== 1 || !("project" in data))
    throw new Error("Backup cloud non valido.");
  const project = data.project as FactoryProject;
  if (!project.id || !Array.isArray(project.stages) || !project.config?.name) throw new Error("Progetto cloud incompleto.");
  const restored = "settings" in data ? data.settings : undefined;
  const cloudSettings = restored && typeof restored === "object" && "profiles" in restored && Array.isArray(restored.profiles) &&
    "assignments" in restored && typeof restored.assignments === "object" && restored.assignments &&
    "git" in restored && typeof restored.git === "object" && restored.git &&
    "cloud" in restored && typeof restored.cloud === "object" && restored.cloud
    ? restored as FactorySettings : undefined;
  return { project, settings: cloudSettings };
}
export function saveCloudConfig(settings: FactorySettings): void { persistSettings(settings); }

const RUNNER_VAULT_NAME = "softwarefactory-runner-vault.v1.json";
/**
 * Separate app-folder object: a normal project/settings backup cannot erase the
 * encrypted runner API key. The cloud service receives ciphertext only.
 * Initial manual UX; compare-and-swap/concurrent-device merge is NOT implemented.
 */
async function runnerVaultCloudRequest(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init, mode: "cors", redirect: "error", cache: "no-store",
    headers: { Authorization: "Bearer " + token, ...init.headers },
  });
  if (!response.ok) throw Error("Cloud runner vault HTTP " + response.status + ".");
  return response;
}
async function runnerVaultCloudLocation(provider: "google" | "microsoft", token: string): Promise<string | null> {
  if (provider === "microsoft")
    return "https://graph.microsoft.com/v1.0/me/drive/special/approot:/" + RUNNER_VAULT_NAME + ":/content";
  const params = new URLSearchParams({
    spaces: "appDataFolder", q: "name = '" + RUNNER_VAULT_NAME + "' and trashed = false",
    fields: "files(id,name)", pageSize: "10",
  });
  const response = await runnerVaultCloudRequest("https://www.googleapis.com/drive/v3/files?" + params, token);
  const list: unknown = await response.json();
  if (!list || typeof list !== "object" || !("files" in list) ||
      !Array.isArray(list.files) || list.files.length > 10)
    throw Error("Risposta elenco vault cloud non valida.");
  const ids = list.files as Array<{ id?: unknown }>;
  if (ids.length > 1) throw Error("Sono presenti più vault con lo stesso nome: risolvere manualmente.");
  if (!ids.length) return null;
  if (typeof ids[0].id !== "string" || !/^[A-Za-z0-9_-]{8,200}$/.test(ids[0].id))
    throw Error("Riferimento vault cloud non valido.");
  return "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(ids[0].id);
}
export async function saveEncryptedRunnerVault(settings: FactorySettings, passphrase: string): Promise<void> {
  const token = readSecret("cloud." + settings.cloud.provider);
  const apiKey = readSecret("runner.key");
  if (!token) throw Error("Connetti prima il cloud selezionato.");
  if (!settings.runnerEndpoint || !apiKey) throw Error("Configura prima URL e API key del runner.");
  // All secrets encrypted in-browser BEFORE any cloud request using only WebCrypto.
  const encrypted = await encryptRunnerCredential(settings.runnerEndpoint, apiKey, passphrase);
  const body = JSON.stringify(encrypted);
  const provider = settings.cloud.provider;
  const target = await runnerVaultCloudLocation(provider, token);
  if (provider === "microsoft") {
    await runnerVaultCloudRequest(target!, token, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body,
    });
  } else if (target) {
    await runnerVaultCloudRequest("https://www.googleapis.com/upload/drive/v3/files/" +
      target.split("/").at(-1) + "?uploadType=media", token, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body,
    });
  } else {
    const boundary = "sfvault_" + crypto.randomUUID().replace(/-/g, "");
    const payload = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify({ name: RUNNER_VAULT_NAME, parents: ["appDataFolder"], mimeType: "application/json" }) +
      "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + body +
      "\r\n--" + boundary + "--";
    await runnerVaultCloudRequest("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", token, {
      method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body: payload,
    });
  }
}
export async function restoreEncryptedRunnerVault(settings: FactorySettings, passphrase: string):
  Promise<{ endpoint: string; apiKey: string }> {
  const token = readSecret("cloud." + settings.cloud.provider);
  if (!token) throw Error("Connetti prima il cloud selezionato.");
  const provider = settings.cloud.provider;
  const location = await runnerVaultCloudLocation(provider, token);
  if (!location) throw Error("Nessun vault runner salvato nell'app folder.");
  const url = provider === "microsoft" ? location : location + "?alt=media";
  const response = await runnerVaultCloudRequest(url, token);
  const bytes = await response.text();
  if (bytes.length > 8192) throw Error("Vault runner cloud troppo grande.");
  let encrypted: unknown;
  try { encrypted = JSON.parse(bytes); } catch { throw Error("Vault runner non valido."); }
  validateRunnerVault(encrypted);
  return decryptRunnerCredential(encrypted, passphrase);
}
