# Installer SoftwareFactory — Linux (Italiano)

Il bundle è distribuito tramite [GitHub Releases](https://github.com/KeyserDSoze/SoftwareFactory/releases). Il programma installa il runner e il connector Cloudflare **sul server**, non nel browser. È sperimentale: usare una VM Ubuntu/Debian **dedicata**, non un server con dati importanti.

## 1. Scarica e verifica

Da **SoftwareFactory → Impostazioni → Runner**, usa il link alla release più recente (se presente). Scarica **entrambi** `softwarefactory-runner-installer.tar.gz` e `softwarefactory-runner-installer.tar.gz.sha256`, nella stessa cartella. Da terminale Linux:

```bash
sha256sum -c softwarefactory-runner-installer.tar.gz.sha256
tar -tzf softwarefactory-runner-installer.tar.gz | head
tar -xzf softwarefactory-runner-installer.tar.gz
cd softwarefactory-runner-installer
```

Fermati se la verifica SHA-256 non è positiva o i file provengono da un dominio diverso da GitHub. Controlla sempre il codice installato: un checksum pubblicato nella stessa release prova integrità del download, non autenticità indipendente del produttore.

## 2. Prepara un server Linux

Il wizard richiede **Ubuntu/Debian**, Node.js 22, `git`, `sudo`, un utente dedicato **UID 1000** (non root) e un terminale interattivo. Non installa Node.js né crea account. Deve essere una macchina senza un Docker rootful già attivo. Preparati a concedere privilegi sudo per l'installazione dei pacchetti Docker ufficiali.

## 3. Crea il tunnel nel tuo Cloudflare

Nel Cloudflare Dashboard vai in **Networking → Tunnels**, crea un tunnel e copia il **token del connettore**. Imposta un dominio gestito da Cloudflare e scegli un hostname HTTPS, ad esempio `runner.example.com`. Configura politiche di accesso/identità per l'API e consenti le preflight `OPTIONS` dal browser.

## 4. Avvia il wizard in locale

```bash
node src/runner/scripts/interactive-install.mjs
```

Conferma scrivendo **INSTALLA**: lo script chiede l'origine esatta del sito (per GitHub Pages `https://keyserdsoze.github.io`, **senza** `/SoftwareFactory/`), l'URL pubblico HTTPS, il **token Cloudflare in un campo TTY nascosto** e una API key generata o personalizzata di almeno 32 caratteri. Il token Cloudflare non viene inviato alla SPA.

Docker Engine rootless usa `systemctl --user` e `loginctl enable-linger 1000` per riavviarsi. I container API, worker e `cloudflared` hanno `restart: unless-stopped`. Il server espone localmente solo `127.0.0.1:8787`.

## 5. Configura l'instradamento

In **Networking → Tunnels → Routes → Add route → Published application** scegli il tuo hostname. Service type **HTTP**, service URL **`http://runner-api:8787`** (porta interna 8787). *Non* impostare `localhost:8787` nel servizio del container cloudflared. Sul sito in **Impostazioni → Runner** inserisci `https://runner.example.com` e **solo** la API key runner, poi verifica la connessione.

## 6. Collaudo e manutenzione

Riavvia realmente il server, controlla `systemctl --user status docker`, lo stato dei container e le readiness API tramite HTTPS. Prova un job di test **approvato** e verifica il JSON. La release non è ancora collaudata con tutte le configurazioni di kernel/Cloudflare/Access. Il token è ancora configurato in Compose: il file di configurazione host deve restare privato, ma gli operatori Docker possono ispezionarlo. Per aggiornare o rimuovere, segui [docs/runner.md](docs/runner.md): non eseguire di nuovo l'installer sullo stesso host per sovrascrivere credenziali esistenti.

## Protezioni obbligatorie dell'installer RC.2+ (#95)

**Non usare `v0.2.0-rc.1` per nuove installazioni.** Tale archivio precede il manifest sorgenti e il wizard utilizzava un avvio non verificato. Scarica la Release `v0.2.0-rc.2` o successiva dal pannello dell'app; usa solo VM dedicate. Dopo `sha256sum -c`, conserva l'archivio nella cartella padre estratta. Quando il wizard te lo chiede, indica **il percorso assoluto dell'archivio** (ad esempio `/home/utente/Download/softwarefactory-runner-installer.tar.gz`) e **il valore SHA-256 di 64 caratteri** del file `.sha256` verificato; non è una chiave segreta. Il wizard rilegge il manifest **nell'archivio verificato** e controlla tutti i file estratti: se file/manifests non coincidono, interrompe tutto prima di sudo/apt.

Dovrai approvare digitando la **SHA-40 completa** del sorgente, da confrontare con il commit associato alla Release su GitHub; poi fornire una **immagine canary immutabile** `node@sha256:<digest64>` revisionata dall'operatore (non un semplice `node:latest`). La CLI deve realmente provare `vm-acceptance` e completare il canary Docker rootless con cleanup prima di installare API/worker; verifica la loro readiness Bearer in loopback prima di tentare Cloudflared. Il token Tunnel è letto in TTY nascosto; **non è una firma** e non deve andare nel browser. Se fallisce un passaggio lascia l'host in stato da ispezionare manualmente; non esegue rollback/prune dei container.

Per una installazione manuale da checkout Git pulito `main` continua a funzionare `host-install` con `--commit` e `--image`; il vecchio `host-setup start` è bloccato e non va usato. Avvio tunnel isolato dopo installazione: `node src/runner/scripts/host-setup.mjs tunnel --confirm-tunnel`. **Attenzione:** la verifica locale di installazione e il successo dei test GitHub CI non attestano Cloudflare/DNS/Access, reboot né VM Docker rootless fisica. Richiesto collaudo reale prima di pubblicare hostname di produzione.
