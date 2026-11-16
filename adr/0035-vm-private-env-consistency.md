# ADR 0035 — Lettura stabile dell'ambiente privato lungo l'acceptance VM

- Data: 2026-11-16
- Stato: accettato per la CLI operator-only sperimentale
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/78
- Precedenti: ADR 0021, 0031, 0034

## Contesto

Il gate VM introdotto nella #77 invocava in sequenza `preflight compose`, `preflight host` e `rootless-canary`. Compose e host non condividono un descriptor/una transazione: `docker compose --env-file` può leggere il pathname prima o dopo una rotazione, mentre l'host legge i valori da un nuovo descriptor privato. Un operatore potrebbe ottenere prove singolarmente `passed` per configurazioni differenti e combinarle nella ricevuta finale. Inoltre la privacy 0600 del file non era controllata **prima** di eseguire la CLI Docker Compose.

## Decisione

1. Importare nella CLI VM la funzione `readPrivateEnv` già revisionata, che usa `O_NOFOLLOW`, singolo FD, proprietà dell'euid corrente, link unico, mode 0600, dimensione limitata e due `fstat` consistenti. La prima lettura avviene prima di Compose, senza fallback a `process.env`.
2. Derivare una rappresentazione canonica privata della configurazione effettiva (chiavi ordinate e coppie chiave/valore) senza esporla né memorizzarla nel risultato. Ri-leggere il file in sicurezza dopo `preflight compose`, dopo `preflight host` e dopo `runRootlessCanary`, richiedendo uguaglianza di tutti i valori e delle chiavi; l'ordine nel file non ha significato. I duplicati continuano a essere rifiutati dal parser `readPrivateEnv`.
3. Bloccare ogni transizione se manca il file, se è cambiato o se si verificano errori (anche con diagnostica che contenga secret). Emit del recovery UUID solo **dopo** la doppia verifica Compose/host; dopo canary l'eventuale mismatch impedisce la receipt anche quando cleanup è confermata.
4. Test Node di rotazione ai singoli boundary, cambio ordine permesso, read exception sanitize e vera sostituzione di file privato mediante `rename` atomico su Linux. Non mettere dati sensibili, digest, file path o secret nella receipt `RUNNER_VM_ACCEPTANCE_PASS`.

## Trade-off e limiti

Si aggiungono quattro letture private bounded a ogni acceptance. Questi sono controlli point-in-time, **non** una transazione che blocca i file o il daemon: swap-and-restore fra due letture e sostituzione della socket restano possibili contro host compromesso. È necessario che l'operatore sospenda le rotazioni per la durata del collaudo. La CI su GitHub (Docker rootful) non certifica una VM Docker rootless reale, un Cloudflare Access/Tunnel effettivo, un nodo attendibile o un'ancora indipendente; epic #2 resta aperta.
