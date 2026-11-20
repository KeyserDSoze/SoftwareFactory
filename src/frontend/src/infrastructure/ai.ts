import type { AiProfile } from "../domain/types";
import type { ThinkingChoice } from "../domain/agent-roles";
import { t, type FactoryLocale } from "../i18n";

/** Values observed in a successful /chat/completions HTTP response.
 * Neither the provider's accounting nor its price is independently verified.
 * This object never contains prompts, secrets, response bodies or URLs.
 */
export interface AiUsageObservation {
  readonly assurance: "provider_reported_unverified";
  readonly profileId: string;
  readonly requestedModel: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}
export type AiUsageListener = (observation: AiUsageObservation) => void;
const MAX_REPORTED_TOKENS = 1_000_000_000;
function validTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= MAX_REPORTED_TOKENS;
}
/** No estimates if usage is absent, incomplete, inconsistent or oversized.
 * Ignore extra provider-specific fields and arbitrary provider identifiers.
 */
export function parseProviderReportedUsage(
  raw: unknown, profileId: string, requestedModel: string,
): AiUsageObservation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = (raw as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const fields = usage as Record<string, unknown>;
  const prompt = fields.prompt_tokens;
  const completion = fields.completion_tokens;
  const total = fields.total_tokens;
  if (!validTokens(prompt) || !validTokens(completion) || !validTokens(total) ||
      prompt + completion !== total) return null;
  return {
    assurance: "provider_reported_unverified",
    profileId, requestedModel,
    promptTokens: prompt, completionTokens: completion, totalTokens: total,
  };
}
/** Label visibly distinguishes observed response fields from verified billing. */
export function formatProviderReportedUsage(
  receipt: AiUsageObservation, locale: FactoryLocale = "it",
): string {
  const fmt = new Intl.NumberFormat(locale);
  return `${t(locale, "providerUsagePrefix")}: ${t(locale, "providerUsageInput")} ${fmt.format(receipt.promptTokens)}, ${t(locale, "providerUsageOutput")} ${fmt.format(receipt.completionTokens)}, ${t(locale, "providerUsageTotal")} ${fmt.format(receipt.totalTokens)}. ${t(locale, "providerUsageNoCost")}`;
}
export class ProviderError extends Error {
  constructor(message: string) { super(message); this.name = "ProviderError"; }
}

/** In the browser, OpenAI-compatible endpoints may omit role and
 * finish_reason. Retain that legacy behavior, but NEVER accept an explicitly
 * truncated, filtered, tool-routed or refused answer as a completed task.
 * The provider metadata is not independently attested.
 */
function completedAiText(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !("choices" in body) || !Array.isArray(body.choices) ||
      body.choices.length !== 1)
    throw new ProviderError("Il provider non ha restituito una sola risposta compatibile.");
  const choice: unknown = body.choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice))
    throw new ProviderError("Il provider ha restituito una risposta non valida.");
  const item = choice as Record<string, unknown>;
  // Explicit null, unknown, length, content_filter, tool_calls and
  // function_call finish values all mean we cannot treat this as finished.
  if (Object.hasOwn(item, "finish_reason") && item.finish_reason !== "stop")
    throw new ProviderError("Il provider ha dichiarato una risposta incompleta o filtrata.");
  const message = item.message;
  if (!message || typeof message !== "object" || Array.isArray(message))
    throw new ProviderError("Il provider ha restituito una risposta non valida.");
  const assistant = message as Record<string, unknown>;
  if (Object.hasOwn(assistant, "role") && assistant.role !== "assistant" ||
      assistant.refusal !== undefined && assistant.refusal !== null ||
      assistant.tool_calls !== undefined && assistant.tool_calls !== null ||
      assistant.function_call !== undefined && assistant.function_call !== null)
    throw new ProviderError("Il provider ha restituito una risposta non utilizzabile.");
  if (typeof assistant.content !== "string" || !assistant.content.trim())
    throw new ProviderError("Il provider ha restituito una risposta vuota.");
  return assistant.content.trim();
}

/** A remote OpenAI-compatible endpoint may return an enormous or malformed
 * JSON response even with HTTP 200. Bound actual decoded stream bytes before
 * decoding/parsing; Content-Length is advisory and never the only limit.
 */
const MAX_COMPLETION_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_MODELS_RESPONSE_BYTES = 512 * 1024;

async function readBoundedProviderJson(response: Response, maxBytes: number): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    if (response.body && typeof response.body.getReader === "function")
      reader = response.body.getReader();
    const declared = response.headers?.get?.("content-length");
    if (declared !== undefined && declared !== null &&
        (!/^(0|[1-9][0-9]{0,9})$/.test(declared) || Number(declared) > maxBytes))
      throw new ProviderError("La risposta del provider dichiara una dimensione non ammessa.");

    let body: unknown;
    if (reader) {
      let count = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array))
          throw new ProviderError("Il provider ha restituito byte non validi.");
        if (chunk.value.byteLength > maxBytes - count)
          throw new ProviderError("Risposta del provider troppo grande.");
        count += chunk.value.byteLength;
        chunks.push(chunk.value);
      }
      if (count === 0) throw new ProviderError("Risposta del provider vuota.");
      const bytes = new Uint8Array(count);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } else if (typeof response.text === "function") {
      // Nonstreaming transports cannot prevent the initial allocation, but
      // still cannot feed unbounded data to JSON.parse or downstream logic.
      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > maxBytes)
        throw new ProviderError("Risposta del provider troppo grande.");
      body = JSON.parse(raw);
    } else {
      // Compatibility for minimal in-memory fetch mocks using json() only.
      // Real browser Response objects expose body/text; never rely on this
      // fallback for streaming network size enforcement.
      body = await response.json();
      const raw = JSON.stringify(body);
      if (typeof raw !== "string" ||
          new TextEncoder().encode(raw).byteLength > maxBytes)
        throw new ProviderError("Risposta del provider troppo grande.");
    }
    return body;
  } catch (error) {
    // Cancel as soon as an overflow, invalid JSON or stream failure is seen.
    // Do not leak raw provider JSON/stream errors, prompts or credentials.
    if (reader) {
      try { await reader.cancel(); } catch { /* best-effort network abort */ }
    }
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("Risposta del provider non valida o interrotta.");
  } finally {
    reader?.releaseLock();
  }
}

export function validateAiEndpoint(input: string): string {
  const url = new URL(input);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash)
    throw new ProviderError("Endpoint AI non valido: usa HTTPS, oppure HTTP solo su localhost.");
  return url.href.replace(/\/$/, "");
}
export async function aiComplete(profile: AiProfile, apiKey: string, system: string, user: string,
  signal?: AbortSignal, options?: {
    model?: string; thinking?: ThinkingChoice; onUsage?: AiUsageListener;
  }): Promise<string> {
  const model = (options?.model ?? profile.model).trim();
  if (!model) throw new ProviderError("Configura il modello AI nelle Impostazioni.");
  const thinking = options?.thinking ?? profile.reasoningEffort;
  if (thinking !== undefined && !["automatic", "low", "medium", "high", "xhigh"].includes(thinking))
    throw new ProviderError("Livello di thinking non valido.");
  const endpoint = validateAiEndpoint(profile.baseUrl);
  const response = await fetch(endpoint + "/chat/completions", {
    method: "POST", mode: "cors", redirect: "error", signal,
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
    // BookWriter-style: "automatic" omits the optional provider field.
    // Most reasoning models reject temperature together with reasoning_effort.
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }],
      ...(thinking && thinking !== "automatic" ? { reasoning_effort: thinking } : { temperature: 0.3 }) }),
  });
  if (!response.ok) throw new ProviderError("Provider AI: HTTP " + response.status + ". Controlla endpoint, credenziali e modello.");
  const body: unknown = await readBoundedProviderJson(response, MAX_COMPLETION_RESPONSE_BYTES);
  // Validate the completion envelope before a pipeline/code-agent task
  // can receive output or its optional provider-reported token observation.
  const text = completedAiText(body);
  // An optional in-memory observation follows only a usable completion.
  // Third-party usage is a claim, not a signed bill or runner proof.
  const observed = parseProviderReportedUsage(body, profile.id, model);
  if (observed && !signal?.aborted) {
    try { options?.onUsage?.(observed); }
    catch { /* UI observers must never invalidate a completed AI response. */ }
  }
  return text;
}

/**
 * BookWriter-style explicit model inventory. GET only, no prompt or source code.
 * Do not follow redirects with Bearer credentials and never trust model metadata.
 */
export async function discoverAiModels(profile: AiProfile, apiKey: string,
  signal?: AbortSignal): Promise<string[]> {
  const endpoint = validateAiEndpoint(profile.baseUrl);
  const host = new URL(endpoint).hostname;
  if (!apiKey && !["localhost", "127.0.0.1", "[::1]"].includes(host))
    throw new ProviderError("Senza API key è consentita la discovery soltanto su localhost.");
  let response: Response;
  try {
    response = await fetch(endpoint + "/models", {
      method: "GET", mode: "cors", redirect: "error", cache: "no-store", signal,
      headers: apiKey ? { Authorization: "Bearer " + apiKey } : {},
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new ProviderError("Impossibile leggere /models: controlla URL, HTTPS e CORS.");
  }
  if (!response.ok) throw new ProviderError("Catalogo modelli: HTTP " + response.status + ".");
  const data: unknown = await readBoundedProviderJson(response, MAX_MODELS_RESPONSE_BYTES);
  if (!data || typeof data !== "object" || !("data" in data) ||
      !Array.isArray(data.data) || data.data.length > 1000)
    throw new ProviderError("Catalogo /models non valido o troppo grande.");
  const models = (data.data as unknown[]).map(item =>
    item && typeof item === "object" && "id" in item ? item.id : null);
  if (models.some(v => typeof v !== "string" || !v.trim() ||
      v.length > 200 || /[\u0000-\u001f\u007f]/.test(v)))
    throw new ProviderError("Il catalogo contiene identificatori di modello non validi.");
  return [...new Set(models as string[])].slice(0, 500);
}
