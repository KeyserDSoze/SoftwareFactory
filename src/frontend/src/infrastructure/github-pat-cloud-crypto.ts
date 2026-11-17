/** Independent GitHub PAT cloud vault. No runner endpoint or Cloudflare token
 * is present. PBKDF2(600k)/AES-GCM with domain-separated AAD and random salt/IV.
 */
import { assertGithubPat } from "./github-pat-device";

export type GithubPatEncryptedVault = {
  schemaVersion: 1; kind: "github-pat"; kdf: "PBKDF2-SHA256";
  iterations: 600000; cipher: "AES-256-GCM";
  salt: string; iv: string; ciphertext: string;
};
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const AAD = encoder.encode("SoftwareFactory GitHub PAT cloud vault v1");
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
function decode64(v: unknown, min: number, max: number): Uint8Array {
  if (typeof v !== "string" || v.length < min || v.length > max ||
      !/^[A-Za-z0-9_-]+$/.test(v)) throw Error("Vault PAT cloud non valido.");
  const bytes = Uint8Array.from(atob(v.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - v.length % 4) % 4)), c => c.charCodeAt(0));
  if (base64(bytes) !== v) throw Error("Vault PAT cloud non valido.");
  return bytes;
}
export function validateGithubPatVault(raw: unknown): GithubPatEncryptedVault {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Vault PAT cloud non valido.");
  const r = raw as Record<string, unknown>;
  const keys = ["schemaVersion","kind","kdf","iterations","cipher","salt","iv","ciphertext"];
  if (Object.keys(r).sort().join("|") !== keys.sort().join("|") || r.schemaVersion !== 1 ||
      r.kind !== "github-pat" || r.kdf !== "PBKDF2-SHA256" ||
      r.iterations !== 600000 || r.cipher !== "AES-256-GCM" ||
      decode64(r.salt,22,24).length !== 16 || decode64(r.iv,16,16).length !== 12 ||
      decode64(r.ciphertext,40,2048).length < 32)
    throw Error("Vault PAT cloud non valido.");
  return raw as GithubPatEncryptedVault;
}
function checkPassphrase(input: string) {
  if (typeof input !== "string" || input.length < 12 || input.length > 200)
    throw Error("Passphrase vault PAT: usare da 12 a 200 caratteri.");
}
async function makeKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const seed = await crypto.subtle.importKey("raw", encoder.encode(passphrase),
    "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256",
    salt: salt as BufferSource, iterations: 600000 }, seed,
    { name: "AES-GCM", length: 256 }, false, ["encrypt","decrypt"]);
}
export async function encryptGithubPatCloud(pat: string, passphrase: string): Promise<GithubPatEncryptedVault> {
  checkPassphrase(passphrase);
  const secret = assertGithubPat(pat);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await makeKey(passphrase, salt);
  const cipher = await crypto.subtle.encrypt({
    name: "AES-GCM", iv: iv as BufferSource, additionalData: AAD,
  }, key, encoder.encode(JSON.stringify({ token: secret })));
  return validateGithubPatVault({
    schemaVersion: 1, kind: "github-pat", kdf: "PBKDF2-SHA256",
    iterations: 600000, cipher: "AES-256-GCM", salt: base64(salt),
    iv: base64(iv), ciphertext: base64(new Uint8Array(cipher)),
  });
}
export async function decryptGithubPatCloud(raw: unknown, passphrase: string): Promise<string> {
  checkPassphrase(passphrase);
  const v = validateGithubPatVault(raw);
  try {
    const key = await makeKey(passphrase, decode64(v.salt,22,24));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM",
      iv: decode64(v.iv,16,16) as BufferSource, additionalData: AAD }, key,
      decode64(v.ciphertext,40,2048) as BufferSource);
    const decoded: unknown = JSON.parse(decoder.decode(plain));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) ||
        Object.keys(decoded).join("|") !== "token")
      throw Error();
    return assertGithubPat((decoded as { token: string }).token);
  } catch { throw Error("Impossibile aprire il vault GitHub: passphrase errata o file alterato."); }
}
