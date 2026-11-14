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
