# ADR 0046 — Installer interattivo Docker/Cloudflare, telemetria del runner e vault E2EE

- Data: 17 novembre 2026
- Stato: accettato come incremento sperimentale; **non certificato su VM reale**
- Issue: [#89](https://github.com/KeyserDSoze/SoftwareFactory/issues/89),
  [#87](https://github.com/KeyserDSoze/SoftwareFactory/issues/87)
- Precedenti: ADR 0005, 0044, 0045 e `src/runner/scripts/host-install.mjs`

## Contesto e minaccia

SoftwareFactory è una SPA su GitHub Pages: da quel sito non è possibile né
sicuro far eseguire SSH/shell su un host non ancora collegato. Il connector
si installa **localmente tramite operatore sul server**. Il browser usa poi
HTTPS (reverse proxy oppure Cloudflare Tunnel) per le API e OAuth PKCE per
leggere/scrivere dati nell'app-folder privato.

Il Docker socket rootless è comunque privilegiato per l'utente dedicato.
Un host condiviso o che contiene segreti non è un contesto adeguato per
eseguire sorgenti AI non fidati. Le protezioni dei job in `src/runner`
restano obbligatorie e non vengono aggirate dall'installer.

## Decisioni

### Installer, boot e Cloudflare

`src/runner/scripts/interactive-install.mjs` è un wizard **solo TTY**
per Ubuntu/Debian su macchina dedicata con utente UID 1000. Node.js e
questo checkout Git sono prerequisiti. Richiede conferma esplicita
`INSTALLA` prima di installare pacchetti Docker/Compose/rootless
tramite repository Docker ufficiale firmato; verifica fingerprint
`9DC858229FC7DD38854AE2D88D81803C0EBFCD88`, rifiuta sostituzione
di file apt esistenti e non esegue `curl|bash`. Richiede URL browser HTTPS,
origin CORS della SPA, **Cloudflare tunnel token obbligatorio** da TTY
senza echo e API key personalizzata valida oppure random crittografica.
Non accetta token come flag di shell. Configurazione privata in `.env`
con permessi 0600; directory private mode 0700.

Docker rootless parte come user service systemd, con
`loginctl enable-linger 1000` (auto-start dopo reboot); `cloudflared`
è **container nel Compose**, non systemd host package, con
`restart: unless-stopped`, come runner-api e runner-worker.
La VM rifiuta Docker rootful già attivo prima delle modifiche. Porta
API pubblicata sull'host **solo 127.0.0.1:8787**, non su 0.0.0.0;
cloudflared raggiunge `http://runner-api:8787` dalla rete Compose,
senza pubblicare una porta aggiuntiva. L'installer stampa istruzioni:
Cloudflare Dashboard → Networking → Tunnels → select tunnel →
Routes → Add route → Published application, hostname scelto, service
type HTTP, service URL `http://runner-api:8787`, autenticazione
Access e CORS/OPTIONS per `https://keyserdsoze.github.io`.

**Limiti:** il wizard non crea il tunnel nel cloud né configura il DNS
via API (occorrono login nel Cloudflare dashboard), non verifica il
riavvio della VM e non prova un ambiente Docker rootless reale. È
un primo provisioning guidato, non un'assicurazione di operatività
end-to-end. `cloudflared:latest` è una dipendenza attualmente mobile:
verifiche immagini, aggiornamenti sicuri/rollout e pinning digest
richiedono lavoro dedicato in #87. Il token Cloudflare nel
`docker compose command` può essere visibile agli operatori con
permessi Docker: evolvere a file-backed secret con lettura scoped.

### Telemetria opt-in tramite runner già autenticato

Il worker produce ogni 5 s un `worker-metrics.json` privato sul
volume condiviso, **senza** aprire socket Docker nell'API. Misure
minime: CPU% via delta dei tempi `os.cpus()`, RAM used/total via
`os.totalmem()/freemem()`, disco tramite `statfs`, uptime;
temperatura CPU solo da sensore host riconosciuto dal campo
`/sys/class/thermal/thermal_zone*/type`, altrimenti `null`.
`GET /v1/host-metrics` riusa Bearer, CORS e cache-control no-store
e fallisce se file manca, non è privato, è vecchio o non rispetta
lo schema. Il server multi-tenant non espone metriche globali finché
manca ruolo operator autorizzato. La telemetria è best-effort:
guasti di filesystem/sensori non devono bloccare la coda build/test.

Dati mostrati sono **host-visible aggregati**, non metriche per
singolo container, consumo elettrico, heat attestato o misure fisiche
certe in ogni VM. Un browser non deve inventare 0%/0°C se la
misura manca. Polling 5 s in test, 12 s idle, sospeso su scheda nascosta.

### Popup attività BookWriter-style

Un widget espandibile in basso a destra usa `App.busy`, fase pipeline,
task Code Agent e stato del runner osservato. Mostra avanzamento,
tempo visibile, link a pagina dettaglio. Non inventa streaming token
né progresso di agent non implementati; l'orchestratore server-side
duraturo è milestone #89 successiva. La scheda è solo informativa e
non sostituisce stop, approvazioni e report verificati.

### Vault cloud endpoint/API key runner

Il backup corrente del progetto continua a escludere segreti.
Un file separato `softwarefactory-runner-vault.v1.json` in Google
`appDataFolder` oppure OneDrive App Folder contiene **solo**
ciphertext PBKDF2-SHA256 (600000 iterazioni, salt random 16B) +
AES-256-GCM (nonce random 12B, AAD con contesto applicativo). La
passphrase, almeno 12 caratteri, è digitata on demand, non salvata
e non inviata alla rete. L'endpoint HTTPS e la key sono verificati
dopo decrittazione; un errore di autenticazione non distingue
passphrase errata da dati corrotti. Il token Cloudflare resta **solo
sull'host**. L'utente deve esplicitamente approvare salvataggio/
ripristino; in fase di restore la API key va solo in sessionStorage.

**Limiti**: il primo vault gestisce un solo runner, manualmente; NON
fornisce CAS/ETag cloud, merge multi-device, recovery della passphrase
o sincronizzazione continua. Una pagina compromessa da XSS può leggere
chiavi mentre sono sbloccate. Prima di chiamarlo equivalente al profilo
BookWriter servono registry multiplo, versionamento, CAS, conflitti e
hardening anti-XSS (scope autorizzazioni, CSP e rotazione).
