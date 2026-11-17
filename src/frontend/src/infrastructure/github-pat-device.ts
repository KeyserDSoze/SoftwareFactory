/** BookWriter-parity PAT storage: a non-extractable WebCrypto key in IndexedDB,
 * never in project JSON, exported ZIP, localStorage or GitHub. No plaintext fallback.
 */
import { readSecret, saveSecret } from "./store";

const DB_NAME = "softwarefactory.github.device-v1";
const STORE = "private";
const KEY = "device-key";
const PAT = "github-pat";
const AAD = new TextEncoder().encode("SoftwareFactory GitHub PAT local vault v1");
type EncryptedPat = { version: 1; iv: string; ciphertext: string };
const b64 = (value: Uint8Array): string => btoa(String.fromCharCode(...value))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
function from64(v: unknown, expectedMin: number): Uint8Array {
  if (typeof v !== "string" || v.length > 1800 || !/^[A-Za-z0-9_-]+$/.test(v)) throw Error("PAT cifrato non valido.");
  const bytes = Uint8Array.from(atob(v.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - v.length % 4) % 4)), c => c.charCodeAt(0));
  if (bytes.length < expectedMin || b64(bytes) !== v) throw Error("PAT cifrato non valido.");
  return bytes;
}
export function assertGithubPat(pat: string): string {
  const v = typeof pat === "string" ? pat.trim() : "";
  if (v.length < 20 || v.length > 512 || /[^\x21-\x7e]/.test(v))
    throw Error("PAT GitHub non valido: inserisci un token fine-grained di almeno 20 caratteri.");
  return v;
}
async function openDb(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB || !crypto?.subtle) throw Error("IndexedDB/WebCrypto non disponibile: nessun PAT salvato.");
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(Error("Impossibile aprire lo storage cifrato del PAT."));
    req.onblocked = () => reject(Error("Archivio PAT bloccato da un'altra scheda."));
  });
}
function read<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(Error("Lettura PAT cifrato non riuscita."));
  });
}
function write(db: IDBDatabase, key: string, value: unknown, insertOnly = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE)[insertOnly ? "add" : "put"](value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(Error("Salvataggio PAT cifrato non riuscito."));
    tx.onabort = () => reject(Error("Salvataggio PAT cifrato interrotto."));
  });
}
function erase(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(Error("Cancellazione PAT cifrato non riuscita."));
    tx.onabort = () => reject(Error("Cancellazione PAT cifrato interrotta."));
  });
}
async function getDeviceKey(db: IDBDatabase): Promise<CryptoKey> {
  const existing = await read<CryptoKey>(db, KEY);
  if (existing) return existing;
  const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  try { await write(db, KEY, candidate, true); return candidate; }
  catch {
    // Concurrent browser tab may have inserted a different key. Never encrypt
    // with the loser: only use the durable winner from IndexedDB.
    const winner = await read<CryptoKey>(db, KEY);
    if (!winner) throw Error("Concorrenza non risolta nella chiave dispositivo.");
    return winner;
  }
}
export async function sealGithubPat(pat: string, key: CryptoKey): Promise<EncryptedPat> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
    additionalData: AAD }, key, new TextEncoder().encode(assertGithubPat(pat)));
  return { version: 1, iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) };
}
export async function unsealGithubPat(raw: unknown, key: CryptoKey): Promise<string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("PAT cifrato non valido.");
  const entry = raw as Record<string, unknown>;
  if (Object.keys(entry).sort().join(",") !== "ciphertext,iv,version" || entry.version !== 1)
    throw Error("Formato PAT cifrato non supportato.");
  const iv = from64(entry.iv, 12);
  if (iv.length !== 12) throw Error("IV PAT cifrato non valido.");
  const encrypted = from64(entry.ciphertext, 32);
  try {
    const result = await crypto.subtle.decrypt({ name: "AES-GCM", iv,
      additionalData: AAD }, key, encrypted);
    return assertGithubPat(new TextDecoder("utf-8", { fatal: true }).decode(result));
  } catch { throw Error("PAT locale alterato o chiave dispositivo non disponibile."); }
}
export async function saveGithubPatOnDevice(pat: string): Promise<void> {
  const secret = assertGithubPat(pat);
  const db = await openDb();
  try {
    const key = await getDeviceKey(db);
    await write(db, PAT, await sealGithubPat(secret, key));
    saveSecret("github.pat", secret);
  } finally { db.close(); }
}
export async function unlockGithubPatOnDevice(): Promise<boolean> {
  const db = await openDb();
  try {
    const encrypted = await read<unknown>(db, PAT);
    if (!encrypted) return false;
    const key = await read<CryptoKey>(db, KEY);
    if (!key) throw Error("Chiave locale del PAT mancante.");
    saveSecret("github.pat", await unsealGithubPat(encrypted, key));
    return true;
  } finally { db.close(); }
}
export async function deviceHasGithubPat(): Promise<boolean> {
  const db = await openDb();
  try { return Boolean(await read<unknown>(db, PAT)); } finally { db.close(); }
}
export async function forgetGithubPatOnDevice(): Promise<void> {
  const db = await openDb();
  try { await erase(db, PAT); } finally { db.close(); }
  // Do not clear session if durable erase failed.
  saveSecret("github.pat", "");
}
export function forgetGithubPatInSession(): void { if (readSecret("github.pat")) saveSecret("github.pat", ""); }
