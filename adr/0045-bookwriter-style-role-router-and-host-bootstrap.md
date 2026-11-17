# ADR 0045 — Router AI per ruoli, bootstrap host e separazione del profilo cloud

- Stato: **accettato per primo incremento**, software house automatica non ancora completata
- Data: 2026-11-17
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/89
- Dipendenze: #87, #2; ADR 0005 e 0044
- Riferimento: [BookWriter](https://github.com/KeyserDSoze/BookWriter), docs/ai-local-endpoints.md,
  docs/cloud-profile-sync.md, src/frontend/src/domain/task-reasoning.ts

## Contesto
BookWriter usa endpoint OpenAI-compatible configurabili, un route per attività,
thinking `automatic|low|medium|high|xhigh` e profili cloud con vault opzionale.
SoftwareFactory aveva sei assegnazioni a endpoint e un Code Agent che riusava
solo l'endpoint delle fasi implementation/adversarial. Nessuna distinzione tra
developer, revisore e fix nel routing, e nessun installer host nativo.

## Decisione per l'incremento iniziale

1. `domain/agent-roles.ts` cataloga 23 responsabilità. Sei ruoli vengono
   esercitati dalla pipeline; altri tre (fullstack developer, code reviewer e
   fix developer) vengono esercitati dall'attuale Code Agent. Gli altri sono
   **predisposti ma NON eseguono ancora lavoro autonomo**: un menu non è un
   orchestratore e il PM non misura il tempo di job non ancora schedulati.
2. Il route per ruolo (profilo endpoint, modello opzionale, thinking) eredita
   dall'assegnazione di fase precedente e dal modello/effort dell'endpoint.
   Gli override espliciti sono persistiti in Settings, ma mai nei sorgenti
   generati. ID modello vuoto, endpoint disabilitato, campi/ruoli/effort ignoti
   falliscono prima della chiamata: nessun fallback silenzioso a un provider
   differente. Nessun nuovo segreto viene scritto nei settings.
3. `automatic` omette `reasoning_effort`; `low|medium|high|xhigh`
   lo invia in JSON solo quando selezionato. Sulle chiamate con reasoning
   non viene inviato `temperature`, per compatibilità con modelli reasoning.
   **Limite**: la prima iterazione NON legge ancora `/models` e capabilities
   di thinking da ciascun modello né gestisce tutte le peculiarità dei
   provider. Un endpoint non compatibile può rifiutare il parametro;
   la verifica/auto-discovery come in BookWriter è milestone successiva.
4. La pipeline aggiunge ai prompt le responsabilità del ruolo; il Code Agent
   separa gli endpoint di scrittura, review indipendente e repair. Questo
   non supera review/consensi/test obbligatori esistenti né abilita auto-push.
5. Il profilo cloud attuale (backup manuale su Google appDataFolder/OneDrive)
   conserva Settings **non segreti**: include nuovi role routes e URL del
   runner; il ripristino ora riapplica anche questi campi. Le API key restano
   in sessionStorage e **non vengono sincronizzate**. Multi-device automerge,
   vault E2EE con passphrase e revision/CAS sono esplicitamente FUORI
   DALL'INCREMENTO e richiedono progetto dedicato: mai caricare chiavi in
   chiaro solo per promettere parità con BookWriter.

## Come la SPA raggiunge il connector

GitHub Pages ospita file statici. Una volta caricata la SPA, è il **browser**
a effettuare fetch HTTPS verso l'URL API scelto: `https://runner.example.org`.
Server/VM con Docker rootless esegue `cloudflared` che stabilisce un tunnel
*outbound* (o un reverse proxy HTTPS esposto): nessun inbound NAT diretto
necessario in modalità Tunnel. Runner API autentica Bearer, usa CORS allowlist
per l'origin di GitHub Pages (ad esempio `https://keyserdsoze.github.io`,
**senza il path /SoftwareFactory**), e worker separato avvia Docker. Per
localhost sul medesimo PC è consentito HTTP loopback. HTTPS/Access e CORS
devono consentire le preflight OPTIONS e la sessione browser; i service
token Cloudflare non devono mai essere inseriti nel JavaScript pubblico.

La SPA non può scoprire automaticamente un host privato dietro NAT. Il
profilo cloud memorizza l'indirizzo, **non apre un tunnel** né mantiene il
lavoro in background. Per job mentre la scheda è chiusa serve scheduler
server-side indipendente, ancora da implementare.

## Host bootstrap manuale ma eseguibile

`src/runner/scripts/host-setup.mjs setup` eseguito **dall'operatore
sull'host Linux come uid 1000** crea un file `docker/runner/.env` mode 0600
con chiave casuale e origin CORS esatto, directory private 0700 sotto HOME;
non stampa/trasmette il token e rifiuta di sovrascrivere il file.
`start` verifica preflight host rootless e Compose, poi avvia API e worker
con il Compose esistente. Non installa Docker/Node, non copia nulla via SSH,
non esegue `curl|bash`, non configura Tunnel né accetta comandi arbitrari
dal browser. Le directory/socket/daemon sono verificati dai preflight.
I job restano limitati da policy e non hanno socket Docker. Il passaggio
a pacchetto versionato, pairing/revoca e collaudo VM reale/Tunnel resta in #87.

## Rischi e seguito

- XSS sul sito può leggere token sessionStorage; il futuro vault non risolve
  XSS durante lo sblocco. CSP, scoped tokens, Access e identità sono necessari.
- Non usare Cloudflare Tunnel come sostituto dell'autenticazione API.
- La CI Node/Docker è un host CI effimero rootful e **non certifica** una VM
  Linux rootless vera; serve acceptance host su macchina dell'operatore.
- Il modello di software house richiederà task graph, PM scheduler, capability
  per ruoli, monitoraggio tempi, tester su job reali, bug triage/fix e re-test,
  ledger durevole, approvazione indipendente e ancoraggio evidenze.
- Proprietà e routing degli endpoint in cloud vanno migrati usando uno schema
  versionato e controllo conflitti prima della sync automatica.
