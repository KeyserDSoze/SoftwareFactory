/**
 * Explicit single-connector vault, BookWriter-inspired. Only ciphertext is uploaded.
 * The passphrase is not saved, cached, logged, or sent to cloud APIs.
 */
import { runnerEndpoint } from "./runner";

const PBKDF2_ITERATIONS = 600_000;
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
const AAD = encoder.encode("SoftwareFactory cloud runner credential vault v1");
export type RunnerEncryptedVault = {
  schemaVersion: 1; kdf: "PBKDF2-SHA256"; iterations: 600000;
  cipher: "AES-256-GCM"; salt: string; iv: string; ciphertext: string;
};
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
function bytesFrom64(value: unknown, lo: number, hi: number): Uint8Array {
  if (typeof value !== "string" || value.length < lo || value.length > hi ||
      !/^[A-Za-z0-9_-]+$/.test(value))
    throw Error("Vault runner non valido.");
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  let plain: string;
  try { plain = atob(standard + "=".repeat((4 - standard.length % 4) % 4)); }
  catch { throw Error("Vault runner non valido."); }
  const bytes = Uint8Array.from(plain, v => v.charCodeAt(0));
  if (base64url(bytes) !== value) throw Error("Vault runner non valido.");
  return bytes;
}
function passphraseValid(input: string): void {
  if (typeof input !== "string" || input.length < 12 || input.length > 200)
    throw Error("La passphrase del vault deve contenere da 12 a 200 caratteri.");
}
export function validateRunnerVault(value: unknown): RunnerEncryptedVault {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Vault runner non valido.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !==
      ["schemaVersion", "kdf", "iterations", "cipher", "salt", "iv", "ciphertext"].sort().join(",") ||
      v.schemaVersion !== 1 || v.kdf !== "PBKDF2-SHA256" ||
      v.iterations !== PBKDF2_ITERATIONS || v.cipher !== "AES-256-GCM")
    throw Error("Formato o algoritmi del vault non supportati.");
  if (bytesFrom64(v.salt, 22, 24).length !== 16 ||
      bytesFrom64(v.iv, 16, 16).length !== 12 ||
      bytesFrom64(v.ciphertext, 24, 8192).length < 18)
    throw Error("Vault runner non valido.");
  return value as RunnerEncryptedVault;
}
async function keyFromPassphrase(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource,
    iterations: PBKDF2_ITERATIONS,
  }, raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function encryptRunnerCredential(
  endpoint: string, apiKey: string, passphrase: string,
): Promise<RunnerEncryptedVault> {
  passphraseValid(passphrase);
  const canonical = runnerEndpoint(endpoint);
  if (typeof apiKey !== "string" || apiKey.length < 32 || apiKey.length > 256 ||
      /[^\x21-\x7e]/.test(apiKey))
    throw Error("API key runner non valida.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFromPassphrase(passphrase, salt);
  const plain = encoder.encode(JSON.stringify({ endpoint: canonical, apiKey }));
  const encrypted = await crypto.subtle.encrypt({
    name: "AES-GCM", iv: iv as BufferSource, additionalData: AAD,
  }, key, plain as BufferSource);
  return validateRunnerVault({
    schemaVersion: 1, kdf: "PBKDF2-SHA256", iterations: PBKDF2_ITERATIONS,
    cipher: "AES-256-GCM", salt: base64url(salt), iv: base64url(iv),
    ciphertext: base64url(new Uint8Array(encrypted)),
  });
}
export async function decryptRunnerCredential(value: unknown, passphrase: string):
  Promise<{ endpoint: string; apiKey: string }> {
  passphraseValid(passphrase);
  const vault = validateRunnerVault(value);
  try {
    const key = await keyFromPassphrase(passphrase, bytesFrom64(vault.salt, 22, 24));
    const plain = await crypto.subtle.decrypt({
      name: "AES-GCM", iv: bytesFrom64(vault.iv, 16, 16) as BufferSource,
      additionalData: AAD,
    }, key, bytesFrom64(vault.ciphertext, 24, 8192) as BufferSource);
    const parsed: unknown = JSON.parse(decoder.decode(plain));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error();
    const secret = parsed as Record<string, unknown>;
    if (Object.keys(secret).sort().join(",") !== "apiKey,endpoint" ||
        typeof secret.endpoint !== "string" ||
        runnerEndpoint(secret.endpoint) !== secret.endpoint ||
        typeof secret.apiKey !== "string" || secret.apiKey.length < 32 ||
        secret.apiKey.length > 256 || /[^\x21-\x7e]/.test(secret.apiKey))
      throw Error();
    return { endpoint: secret.endpoint, apiKey: secret.apiKey };
  } catch {
    // Do not distinguish bad passphrase, forged vault or corrupted provider data.
    throw Error("Impossibile aprire il vault: passphrase errata o dati non validi.");
  }
}
