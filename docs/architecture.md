# SoftwareFactory — architettura

## Obiettivo

Riprendere il modello di BookWriter: tante componenti autonome che trasformano un brief in artefatti, con fasi riprendibili, versionamento, connettori intercambiabili e review. **Factory** e **applicazione generata** hanno confini diversi.

```text
SoftwareFactory SPA (browser)
  ├── domain/       ProjectConfig, Stage, Profile, ServiceBinding
  ├── application/  pipeline per task, prompt, gate, generatore deterministico
  ├── infrastructure/
  │     ├── localStorage per progetto/settings, sessionStorage per token
  │     ├── AI OpenAI-compatible /chat/completions
  │     ├── ricerca: gateway HTTPS + fallback Wikipedia
  │     ├── GitHub REST Git Data + create repo (PAT o App broker)
  │     └── OAuth PKCE Google Drive / MS Graph OneDrive app-folder
  ├── components/    Code Agent / Runner Panel (patch, review, test evidence, repair)
  ├── infrastructure/runner.ts  API client + canonical snapshot hash and report verification
  └── App.tsx        Workspace / AI Factory / Code Agent / Architecture / Settings

SoftwareFactory Runner remoto (sperimentale, opzionale):
  ├── runner-api (Bearer API key, allowlist, queue + SHA-256)
  ├── runner-worker (rootless Docker socket, solo su VM dedicata)
  ├── test containers (network none, CPU/RAM/timeout)
  └── Cloudflare Tunnel (opzionale)

Generato dal composer, salvabile come ZIP o Git commit:
  ├── .github/workflows/ci.yml
  ├── docs/          features, research, architecture
  ├── adr/           0001-modular-ddd.md
  ├── docker/        compose, Dockerfile web e API, env example
  ├── infra/         Terraform bootstrap / Kubernetes scaffolds
  ├── tests/         strategy e gate da implementare
  └── src/
       ├── frontend/web (React + TS)
       ├── frontend/{android,ios,unity,mobile-react-native} (solo placeholder MVP)
       └── backend/
            ├── applications/Api (ASP.NET Core minimal API)
            ├── business/ (use case services)
            ├── domain/ (entità e value objects)
            └── infrastructure/ (adapter da sviluppare)
```

## State machine e persistenza

Le fasi sono in ordine: `features → competitors → technical → architecture → adversarial → implementation`. Ogni task è un'operazione AI distinta e associata a un profilo modello configurabile. Output validati non-vuoti diventano checkpoint. Rigenerare un task invalida i task successivi; cambiare il brief o lo stack invalida l'intera pipeline. Una richiesta AbortController interrompe l'attesa e ne scarta l'output.

Il workspace e le impostazioni (esclusi token e segreti) sono in localStorage. Durante riapertura, uno step con status `running` diventa `pending`. Questo non è un processo 24/7: non ci sono job server-side e non c'è lease distribuito tra dispositivi nel primo MVP.

## Ricerca e adversarial review

La ricerca produce `ResearchSource {title,url,snippet,query,fetchedAt}`, deduplica gli URL e allega gli spunti al contesto AI. Un adapter gateway configurabile consente integrazioni di motori web; Wikipedia è un fallback molto limitato. Le fonti web non sono istruzioni; i prompt vietano di inventare riferimenti e obbligano a distinguere evidenze e ipotesi. Per contesti normativi sono necessarie **fonti ufficiali, revisione umana e date di validità**.

L'adversarial review lavora su piani già scritti e segnala gate critici; la validazione automatica di accettazione di ogni singolo finding sarà aggiunta in una fase futura.

## Stack configurabile

Gli utenti scelgono binding di database, cache, queue, telemetry e storage separatamente per `development` e `production`. Il manifest descrive questa matrice; la runtime dependency injection e il provisioning completo per ogni provider non sono ancora implementati. Docker Compose avvia lo scheletro locale e i servizi selezionati che hanno un template, Terraform contiene bootstrap provider e documentazione di hardening, non è un deployment completo.

.NET predefinito: **11.0** (STS, release 10 novembre 2026); scelta alternativa **10.0 LTS**. Non usare una versione hardcoded come promessa eterna: aggiornare il catalogo alle nuove release.

## GitHub

Un PAT con permessi minimi può creare una repository privata nel proprio account (se dispone dei permessi) e scrivere su main. Per repo esistenti, il client legge HEAD+tree, crea una tree Git, genera commit e avanza la ref con `force:false`. Per branch diversi da main viene creato un branch a partire da main se assente. Non c'è merge automatico; i conflitti bloccano la pubblicazione. L'installazione GitHub App deve essere gestita da un broker server-side e passare installation token temporanei al browser, mai private keys.

## Evoluzione architetturale

Per diventare una vera code factory autonoma servono: task graph con file ownership, editing del codice per feature, cicli build/test automatici, sandbox isolata, revisori indipendenti, budget AI e rate limiting, PR/merge policy, code execution agent e secret broker. Nessuna di queste capacità è simulata come già pronta nel MVP.

## Verifica del codice generato (issue #3)

Il Code Agent separa tre concetti: review AI (opinione statica), build/test reale (report del runner) e approvazione umana. La seconda fase è collegata a un digest dei sorgenti e alla proposta che la genera, per evitare che un report relativo a file obsoleti venga mostrato come prova per il codice corrente. Il repair guidato dai log è limitato a due tentativi e agli stessi file della feature originale. Una riparazione invalida la review precedente e tutte le evidenze di test; l'approvazione richiede una nuova review e un nuovo build pertinente realmente riuscito.
