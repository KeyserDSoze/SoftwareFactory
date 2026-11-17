# Configurazione dei connettori

## AI

- Endpoint OpenAI-compatible in HTTPS (es. `https://api.openai.com/v1`) oppure HTTP su localhost.
- Nome modello e secret runtime. Ogni task ha un endpoint assegnato.
- Le chiavi sono in `sessionStorage`, non incluse negli export. Dopo la chiusura completa della sessione possono scomparire.
- Il provider deve accettare cross-origin browser e `POST /chat/completions` con `messages` e `temperature`. Per provider con API diverse serve adapter.

## Ricerca

Inserire l'URL di un gateway HTTPS che accetta `GET ?q=...&` e risponde con:

```json
{"results":[{"title":"Risultato","url":"https://example.org/doc","snippet":"Estratto verificabile"}]}
```

Il gateway deve supportare CORS, controllo rate limit e una policy di privacy. Se vuoto, usa MediaWiki italiano come fallback, non come fonte legale/competitor esaustiva. Le query possono trasmettere dettagli del prodotto al servizio scelto.

## GitHub

PAT fine-grained: `Contents: Read/Write` nella repository target; per creare repository servono permessi separati. Impostare owner/repository, main o branch di feature. La SPA non fa merge automatico su main. Per GitHub App, costruire un **gateway HTTPS fidato** lato server con endpoint POST che restituisce `{ "token": "short-lived-installation-token" }` dopo aver autenticato e autorizzato l'utente; NON inserire App private keys, client secret o installation tokens fissi nel bundle statico.

Al push SoftwareFactory crea una tree e un commit git e tenta di avanzare la ref senza force. Se un altro writer ha cambiato la branch, il push può fallire: verificare e rifare la review, non sovrascrivere.

## Google Drive

1. Crea un OAuth Client di tipo Web Application nel progetto Google Cloud e configura l'URI di redirect esatto mostrato da SoftwareFactory.
2. Autorizza la scope `https://www.googleapis.com/auth/drive.appdata`, con PKCE (S256).
3. Seleziona Google, incolla il Client ID pubblico, clicca Connetti.
4. Backup salva uno snapshot JSON nella cartella appDataFolder isolata della app; Ripristina ricarica il progetto.

## Microsoft OneDrive

1. Registra una SPA in Microsoft Entra ID; configura redirect URL nella sezione SPA.
2. Usa gli scope delegati `Files.ReadWrite.AppFolder User.Read` (verifica il supporto nel tenant).
3. Seleziona OneDrive, Client ID e Connetti.
4. Il backup scrive su `/me/drive/special/approot:/softwarefactory-state.json:/content`.

In entrambi i casi i token OAuth hanno durata limitata e non viene implementato un refresh persistente. Il backup sovrascrive lo snapshot precedente e contiene descrizione e piani, **non** PAT/API key. La configurazione OAuth e il consenso dell'utente sono necessari: non esiste una connessione automatica preautorizzata.

Al ripristino si recuperano anche profili AI, routing e configurazione Git/cloud **senza credenziali**: PAT e access token vanno reinseriti nella nuova sessione.

## Connector GitHub Actions per test selettivi e download installer (#90)

- **Release installer SoftwareFactory**: asset pubblici `softwarefactory-runner-installer.tar.gz` e `softwarefactory-runner-installer.tar.gz.sha256` creati dalla Action amministrativa `release-installer.yml` su `main` con versione SemVer. Il frontend GitHub Pages interroga una sola endpoint pubblica `GET /repos/KeyserDSoze/SoftwareFactory/releases/latest`; i download rimangono su github.com. Finché un maintainer non esegue la Action, l'interfaccia segnala correttamente che la Release non esiste. Guide IT/EN incluse.
- **GitHub Actions dei prodotti generati**: il generatore include `.github/workflows/softwarefactory-tests.yml` e lo script reporter. A differenza del runner locale, il codice dev'essere **già committato** e il workflow sul default branch. Il client usa il PAT della sessione per leggere la HEAD della branch, fare `POST /repos/{owner}/{repo}/actions/workflows/softwarefactory-tests.yml/dispatches`, verificare l'esecuzione usando `run-name` con UUID e leggere `GET /actions/runs/{id}/artifacts`. Non contiene PAT nello scaffold, nei comandi test o nel vault del runner.
- **Report JSON**: `schemaVersion:1`, requestId, repository, ref, commitSha, runId, runAttempt, startedAt, finishedAt, state, summary e steps di `passed|failed|incomplete`. Quando GitHub pubblica l'artifact, il browser tenta lo ZIP authenticated download; se il redirect al blob storage causa CORS, l'utente può aprirlo da GitHub e importare localmente lo ZIP. In entrambi i casi verifica l'esatto run e la selezione, non inventa test superati.
- **Autorizzazioni**: PAT fine-grained Contents:read e Actions:read/write per dispatch e lettura. Il push richiede anche Contents:write. I privilegi della Action generata sono `contents:read` e `persist-credentials:false`. Se il branch si muove prima del workflow, la UI segnala risultati non associabili/stale; mai force push/merge automatici.

Questa opzione non sostituisce le verifiche Docker rootless, la firma dei rapporti, i test full-stack con DB, né un agent server-side che continua a lavorare quando GitHub Pages è chiusa. Vedi ADR 0047 e #90.
