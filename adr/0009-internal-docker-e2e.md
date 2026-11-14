# ADR 0009 — Integrazione browser React ↔ ASP.NET Core in rete privata

- Data: 2026-11-14
- Stato: accettato per test CI, non per produzione
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/6

## Contesto

I precedenti test Playwright eseguivano Chromium reale ma intercettavano sempre /health. Non provavano che il browser e la API .NET fossero in grado di comunicare. Il progetto generato non possiede ancora un repository database vero.

## Decisione

1. Conservare la suite mock come baseline ermetica senza backend. Abilitare E2E_MODE=integration per il vero /health e per /api/info. Il test di errore 503 resta mockato intenzionalmente.
2. Nella CI dello scaffold, avviare Api.dll su loopback con readiness e cleanup tramite trap; lanciare Playwright contro Vite sul loopback e l'API locale.
3. Nella CI della Factory, creare una rete Docker per job con --internal e un nome casuale; collocare ASP.NET Core, web Vite e Chromium su questa rete, usando gli alias DNS api e web. Non pubblicare porte sull'host, non fornire segreti o socket Docker ai container.
4. Imporre root filesystem read-only, capability eliminate, limiti CPU/RAM/PIDs, no-new-privileges e UID/GID locale nella macchina GitHub-hosted effimera. L'orchestratore ripulisce sempre container e rete anche in caso di test falliti.
5. Limitare l'hostname extra autorizzato da Vite a web e dichiarare in CORS solo gli origin necessari per localhost e web:4173.

## Limiti

Il test API /api/info non utilizza un DB reale. La CI con Docker rootful effimero non equivale a un server condiviso sicuro, e il runner remoto via Cloudflare non riceve ancora la capacità di creare reti. Prima della produzione servono veri repository e migrazioni, isolamento VM/job, gestione quote/egress e toolchain di test attestata.
