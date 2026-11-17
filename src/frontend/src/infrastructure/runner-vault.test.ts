import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptRunnerCredential, encryptRunnerCredential, validateRunnerVault } from "./runner-vault";
import { fetchRunnerHostMetrics, validateRunnerHostMetrics } from "./runner";
import { saveSecret } from "./store";
import { DEFAULT_SETTINGS } from "../domain/defaults";
import { restoreEncryptedRunnerVault, saveEncryptedRunnerVault } from "./cloud";

const API_KEY = "s".repeat(48);
const PASSWORD = "another secure passphrase for tests";
const ENDPOINT = "https://runner.example.com";
const metrics = () => ({
  version: 1, measuredAt: new Date().toISOString(),
  cpuPercent: 33, memoryUsedBytes: 3, memoryTotalBytes: 4,
  diskUsedBytes: 1, diskTotalBytes: 8, uptimeSeconds: 100, cpuTemperatureC: null,
});
describe("runner cloud vault E2EE and resource metrics", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  it("encrypts URL and API key locally; passphrase never appears in ciphertext", async () => {
    const a = await encryptRunnerCredential(ENDPOINT, API_KEY, PASSWORD);
    const b = await encryptRunnerCredential(ENDPOINT, API_KEY, PASSWORD);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(JSON.stringify(a)).not.toContain(ENDPOINT);
    expect(JSON.stringify(a)).not.toContain(API_KEY);
    expect(JSON.stringify(a)).not.toContain(PASSWORD);
    expect(validateRunnerVault(a)).toEqual(a);
    expect(await decryptRunnerCredential(a, PASSWORD)).toEqual({ endpoint: ENDPOINT, apiKey: API_KEY });
    await expect(decryptRunnerCredential(a, "wrong password with enough length")).rejects.toThrow(/Impossibile/);
  });
  it("rejects wrong schema, tampering and short passwords, never decrypts arbitrary object", async () => {
    await expect(encryptRunnerCredential(ENDPOINT, API_KEY, "weak")).rejects.toThrow(/passphrase/);
    for (const bad of [{ schemaVersion: 2 }, { schemaVersion: 1 }, { ...await encryptRunnerCredential(ENDPOINT, API_KEY, PASSWORD), evil: API_KEY }]) {
      expect(() => validateRunnerVault(bad)).toThrow(/Vault|Formato/);
    }
    const good = await encryptRunnerCredential(ENDPOINT, API_KEY, PASSWORD);
    // A random Base64 ciphertext sometimes already starts with "A":
    // overwriting "A" with "A" is NOT tampering and must not be expected to
    // fail AES-GCM. Flip to a guaranteed different, valid Base64 character.
    const flip = good.ciphertext[0] === "A" ? "B" : "A";
    const changed = { ...good, ciphertext: flip + good.ciphertext.slice(1) };
    expect(changed.ciphertext).not.toBe(good.ciphertext);
    await expect(decryptRunnerCredential(changed, PASSWORD)).rejects.toThrow(/Impossibile/);
  });
  it("uploads only ciphertext to Google appDataFolder, loads it without sending passphrase", async () => {
    saveSecret("runner.key", API_KEY);
    saveSecret("cloud.google", "a-google-oauth-token");
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.runnerEndpoint = ENDPOINT;
    const calls: Array<{ url: string; options: RequestInit }> = [];
    let vault = "{}";
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      if (url.includes("/drive/v3/files?") && !url.includes("upload"))
        return { ok: true, json: async () => ({ files: vault === "{}" ? [] : [{ id: "valid1234" }] }) };
      if (url.includes("?alt=media"))
        return { ok: true, text: async () => vault };
      if (url.includes("/upload/")) {
        const body = String(options.body);
        const match = body.match(/\{\s*"schemaVersion":1[^\r\n]*/);
        if (!match) throw Error("vault payload missing");
        const extracted = match[0].split("\r\n")[0];
        vault = extracted.trim();
        return { ok: true, json: async () => ({}) };
      }
      throw Error("unexpected URL " + url);
    }));
    await saveEncryptedRunnerVault(settings, PASSWORD);
    expect(vault).toContain('"ciphertext"');
    expect(JSON.stringify(calls)).not.toContain(API_KEY);
    expect(JSON.stringify(calls)).not.toContain(PASSWORD);
    expect(JSON.stringify(calls)).not.toContain(ENDPOINT);
    expect((await restoreEncryptedRunnerVault(settings, PASSWORD))).toEqual({
      endpoint: ENDPOINT, apiKey: API_KEY,
    });
  });
  it("reads resource metrics only with auth and strict validation (never predicts sensors)", async () => {
    const sample = metrics();
    expect(validateRunnerHostMetrics(sample)).toEqual(sample);
    expect(() => validateRunnerHostMetrics({ ...sample, cpuTemperatureC: 200 })).toThrow();
    expect(() => validateRunnerHostMetrics({ ...sample, processList: [] })).toThrow();
    expect(() => validateRunnerHostMetrics({ ...sample, measuredAt: "2020-01-01T00:00:00.000Z" })).toThrow();
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => sample });
    vi.stubGlobal("fetch", spy);
    expect(await fetchRunnerHostMetrics(ENDPOINT, API_KEY)).toEqual(sample);
    expect(spy.mock.calls[0][0]).toBe(ENDPOINT + "/v1/host-metrics");
    expect(spy.mock.calls[0][1]).toMatchObject({
      method: "GET", redirect: "error", mode: "cors",
      headers: { Authorization: "Bearer " + API_KEY },
    });
  });
});
