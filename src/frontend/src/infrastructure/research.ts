import type { ResearchSource } from "../domain/types";

function toSource(title: string, url: string, snippet: string, query: string): ResearchSource | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return { title: title.trim().slice(0, 200), url: parsed.href, snippet: snippet.trim().slice(0, 1500), query, fetchedAt: new Date().toISOString() };
  } catch { return null; }
}
export async function searchWeb(query: string, endpoint: string, signal?: AbortSignal): Promise<ResearchSource[]> {
  const q = query.slice(0, 180).trim();
  if (!q) return [];
  if (endpoint.trim()) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
      throw new Error("Il gateway di ricerca deve usare HTTPS (oppure localhost).");
    url.searchParams.set("q", q);
    const r = await fetch(url.href, { signal, redirect: "error", mode: "cors" });
    if (!r.ok) throw new Error("Ricerca web non disponibile: HTTP " + r.status);
    const body: unknown = await r.json();
    const items = Array.isArray(body) ? body : body && typeof body === "object" && "results" in body ? (body as { results: unknown }).results : [];
    if (!Array.isArray(items)) throw new Error("Formato ricerca non valido: atteso results[].");
    return items.slice(0, 8).flatMap(x => {
      if (!x || typeof x !== "object") return [];
      const item = x as Record<string, unknown>;
      const source = toSource(String(item.title || ""), String(item.url || ""), String(item.snippet || item.description || ""), q);
      return source ? [source] : [];
    });
  }
  // Public, browser-safe fallback: encyclopedic leads, NOT a complete competitor/legal search.
  const url = new URL("https://it.wikipedia.org/w/api.php");
  url.search = new URLSearchParams({ action: "query", generator: "search", gsrsearch: q, gsrlimit: "5", prop: "extracts", exintro: "1", exsentences: "2", explaintext: "1", format: "json", origin: "*" }).toString();
  const r = await fetch(url.href, { signal, mode: "cors", redirect: "error" });
  if (!r.ok) throw new Error("Wikipedia non raggiungibile: HTTP " + r.status);
  const body = await r.json() as { query?: { pages?: Record<string, { title?: string; extract?: string; pageid?: number }> } };
  return Object.values(body.query?.pages || {}).flatMap(item => {
    const s = toSource(item.title || "", "https://it.wikipedia.org/?curid=" + item.pageid, item.extract || "", q);
    return s ? [s] : [];
  });
}
export function deduplicateSources(sources: ResearchSource[]): ResearchSource[] {
  return [...new Map(sources.map(s => [s.url, s])).values()];
}
