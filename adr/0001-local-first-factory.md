# ADR 0001 — React SPA local-first

- Stato: accettato per MVP
- Data: 2026-11-14

## Contesto

SoftwareFactory riprende BookWriter: orchestrazione AI e workspace direttamente nel browser. L'utente chiede una piattaforma frontend-only con connessioni Git/Drive e factory capace di generare backend .NET per i progetti dei clienti.

## Decisione

React/TypeScript/Vite per il control plane. ProjectConfig, settings e checkpoint in browser; segreti solamente session-scoped. Agent AI e ricerca operano nel tab. La costruzione di app come vero code-writing agent dovrà usare un ambiente sandbox remoto o isolato e sarà una iterazione successiva.

## Conseguenze

Minori costi di gestione, GitHub Pages compatibile. Nessun lavoro persistente a tab chiusa, nessun isolamento dei token da script malevoli sullo stesso origin e CORS provider variabile. I project scaffold generati includono .NET 11, DDD e infrastruttura senza forzare un backend centrale alla Factory.
