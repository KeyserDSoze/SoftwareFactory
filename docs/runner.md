# Remote Test Runner — Docker + Cloudflare Tunnel (issue #2)

**Stato:** MVP sperimentale. API, worker, comandi predeterminati e UI sono implementati, ma il deployment su una VM reale, l'isolamento multi-tenant, il recupero dei container orfani e le build con dipendenze online **non sono stati ancora collaudati end-to-end**. Non esporre questo servizio su server con segreti o workload di produzione.

## Perché non nel browser

.NET WebAssembly esegue codice .NET precompilato, ma non espone nel browser l'intero SDK/compilatore/MSBuild/test runner con accesso al filesystem nativo. Playwright testa browser lanciati in un ambiente Node/OS con browser binaries, non direttamente in una pagina arbitraria. Docker Engine richiede un daemon su un host. La Factory rimane una SPA; invia snapshot a un runner separato.

## Diagramma

```text
Browser SPA (GitHub Pages) — HTTPS
     |  Consentimento invio sorgenti; API key solo sessionStorage
     v
Cloudflare Tunnel + Access (opzionale)
     |  Cloudflared egress-only (nessuna porta pubblica VM)
     v
runner-api (container node non privilegiato)
     | API key SHA-256/timingSafeEqual + CORS esplicito
     | POST /v1/jobs, GET /v1/jobs/:id
     | /data/jobs/<uuid>/input.json, report.json
     v
runner-worker (container node non privilegiato; un solo worker)
     | socket Docker ROOTLESS dedicato, non montato nell'API
     v
Docker daemon ROOTLESS su VM separata (no socket dentro i job)
     | docker run --network=none --read-only --cap-drop=ALL
     | CPU 1, RAM 1GB, pids 128, timeout 120s/step
     v
Container effimeri .NET SDK / Node / Playwright
     | workspace temporaneo, no secrets
     v
report JSON: digest, stato, exitCode, duration, stdout/stderr redatti
```

## Avvio su una VM Linux dedicata

1. Installa Docker Engine **rootless** (utente dedicato, ad esempio uid/gid 1000:1000) e Docker Compose, configura quote CPU, spazio disco e firewall. Non utilizzare un host con workload sensibili. Verifica che il socket rootless sia `/run/user/1000/docker.sock` oppure aggiorna la configurazione.
2. Prepara directory **sull'host e accessibili a uid 1000**:

```bash
sudo mkdir -p /srv/softwarefactory/{runner-data,workspaces}
sudo chown -R 1000:1000 /srv/softwarefactory
git clone https://github.com/KeyserDSoze/SoftwareFactory.git
cd SoftwareFactory
cp docker/runner/.env.example docker/runner/.env
# Genera una key random: openssl rand -hex 32
# Modifica .env con RUNNER_API_KEY, RUNNER_ALLOWED_ORIGINS, host paths e socket.
docker compose --env-file docker/runner/.env -f docker/runner/compose.yml up -d --build
```

Il file `docker/runner/.env` non va committato. **Non montare `/var/run/docker.sock` rootful**. Il socket rootless dà comunque forti poteri al worker: chi lo controlla può avviare container e modificare i volumi di quel daemon. Preferire un daemon separato su VM sacrificabile.

3. Verifica sul server: `curl http://127.0.0.1:8787/healthz` (la sola health non verifica che Docker funzioni). `GET /v1/capabilities` richiede `Authorization: Bearer <RUNNER_API_KEY>`.
4. In Cloudflare Zero Trust crea un **named Tunnel**, configura il token cloudflared nella env e una published application route `runner.tuodominio.it` → `http://runner-api:8787`. Avvia col profilo:

```bash
docker compose --env-file docker/runner/.env -f docker/runner/compose.yml --profile tunnel up -d
```

5. Proteggi il hostname con **Cloudflare Access** (controllo account/identità). Quando la Factory gira su un origin diverso (GitHub Pages), configura accuratamente redirect, CORS e i preflight OPTIONS: i service token Access non vanno distribuiti nel JavaScript o nel browser. Anche con Access l'API richiede la propria API key. Per una configurazione Access browser cross-origin più semplice è possibile pubblicare SPA e runner sotto lo stesso origin tramite un reverse proxy attendibile (ma serve un'architettura aggiuntiva).
6. Nella SPA: **Settings → Remote runner** inserisci `https://runner.tuodominio.it` e l'API key, poi **Code Agent → Test e compilazione reali**. Seleziona gli step e approva esplicitamente l'invio del codice sorgente.

## Contratto API

- `GET /healthz`: sola liveness, non autenticata.
- `GET /v1/capabilities`: lista step disponibili, protetto da Bearer.
- `POST /v1/jobs`: payload JSON `{"label":"feature","files":{"src/backend/domain/EntityId.cs":"..."},"steps":["dotnet-build"]}`. Risponde `202 {id,digest,state:"queued"}`.
- `GET /v1/jobs/{uuid}`: stato `queued | running | passed | failed | incomplete`, SHA-256 dello snapshot, step `passed/failed/skipped`, exit code e log. Se uno step manca o viene saltato, il risultato globale è **incomplete**, non **passed**.

Le operazioni sono fisse, il client non può scegliere comandi shell, immagini o argomenti. Il runner accetta solo subset C#/csproj e frontend web per test, con path allowlist, limite 160 file, totale 1.1MB e 1.5MB di payload. Ogni container ha rete **none** e risorse limitate; root filesystem è read-only (workspace temporaneo scrivibile). I report e input rimangono sulla VM: impostare retention e crittografia filesystem.

## Supporto step

| Step | Comando previsto | Prerequisiti |
| --- | --- | --- |
| dotnet-build | `dotnet build src/backend/applications/Api/Api.csproj -c Release` | .NET 10/11 SDK image, progetto |
| dotnet-test | `dotnet test tests/backend/Tests.csproj -c Release` | progetto di test esplicitamente presente |
| web-build | `npm install --offline --ignore-scripts && npm run build` | dipendenze npm già presenti nella cache del container |
| web-test | `npm install --offline --ignore-scripts && npm run test` | script test in package.json e cache prerequisiti |
| playwright | `npx --no-install playwright test` | spec `src/frontend/web/e2e/*.spec.ts`, Playwright installato, app avviata/configurazione webServer e dipendenze |

**Limiti importanti:** la cache npm non viene pre-popolata dall'MVP; con `--network none` web build/test possono fallire. La Docker image ufficiale Playwright può non includere il modulo npm Playwright, e l'E2E richiede che l'app di test sia raggiungibile con la corretta configurazione di web server. Non dichiarare copertura completa finché ciò non viene risolto. Test skip → `incomplete`; errori di setup → `failed`.

## Test locale del protocollo

```bash
cd src/runner
npm test
npm run check
```

Questi test verificano autenticazione, CORS, schema, hash, limitazioni, pianificazione comandi e report simulando l'esecuzione Docker. **Non provano l'isolamento reale del daemon**. La CI della Factory controlla anche il build frontend e lo scaffold .NET/React.

## Hardening obbligatorio prima di un vero prodotto

- VM dedicata e non privilegiata; rootless Docker user namespace, seccomp/AppArmor, blocco egress, mount, rate limit, quote disco, limiti di job per utente e per IP; evitare il multi-tenant in questa fase.
- Non mettere mai la Docker API sul dominio pubblico. API e worker sono separati, ma il worker ha accesso al socket rootless: in un deployment multi-tenant serve un broker con privilegi minimi e runner effimeri per utente.
- API key forte, rotazione, audit strutturato e gestione accessi per utente; la sessionStorage rimane leggibile da codice JS compromesso (XSS).
- Deduplicazione/idempotency, cancellazione job e container orfani, limiti di storage e retention, limitazione concorrente transazionale, retry espliciti, secret scanning serio e policy di build.
- Cache di dipendenze pre-warmed oppure una fase download controllata con egress esplicito/allowlist; non abilitare rete illimitata al codice AI.
- Versionare immagini Docker per digest, SBOM, SCA e vulnerability scan.
- Per garantire autenticità del risultato associare digest dello snapshot e commit GitHub verificato. Il digest del job non attesta da solo quale versione sia stata pubblicata.
