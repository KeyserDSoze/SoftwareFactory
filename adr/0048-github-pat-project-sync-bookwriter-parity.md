# ADR 0048 — GitHub/PAT parity con BookWriter: profilo, destinazioni, sync e test

Data: 17 novembre 2026 · Stato: **implementazione incrementale (NON ancora collaudata live multi-device)**
Issue [#91](https://github.com/KeyserDSoze/SoftwareFactory/issues/91), collegamenti #89 e #90.

## Contesto e scelta

BookWriter consente PAT GitHub fine-grained cifrato sul dispositivo, discovery guidata delle repository, salvataggi manuali e opzionalmente automatici, importazione cross-device, lock/lease e recupero dei conflitti. SoftwareFactory aveva solo la Git Data API per fare push senza force, PAT in sessionStorage, backup cloud delle impostazioni senza credenziali e GitHub Actions con dispatch e artifact JSON. Il nuovo collegamento implementa le parti riutilizzabili del paradigma senza copiare gli stati editoriali/lease BookWriter in un diverso modello software.

## PAT e profilo cloud

- **Sessione**: il PAT fornito dal browser è un Bearer a `api.github.com` tramite API GitHub preesistenti. Mai nel repository, nel codice generato o nelle Azure/GitHub Actions secrets; non passa agli script della Action.
- **Questo dispositivo**: `github-pat-device.ts` utilizza un `CryptoKey` AES-256-GCM con `extractable=false` generato da WebCrypto e conservato nell'IndexedDB `softwarefactory.github.device-v1`. Il ciphertext + IV casuale sono in IndexedDB; plaintext sbloccato nella sessionStorage solo dopo azione esplicita. Se IndexedDB manca/fallisce, nessun fallback in chiaro. Un JavaScript malevolo eseguito nella stessa origin può comunque accedere al PAT quando sbloccato; questa NON è protezione XSS completa.
- **Google/OneDrive**: `github-pat-cloud-crypto.ts` cifra il PAT con PBKDF2-SHA256 600.000 iterazioni e AES-GCM/IV/salt casuali, AAD separato da runner vault. Il file `softwarefactory-github-pat-v1.json` è indipendente da `softwarefactory-state.json` e dal vault runner. L'upload non contiene il PAT in chiaro. La passphrase >=12 caratteri non è salvata né trasferita al cloud. Il restore richiede consenso e salva nel vault cifrato del nuovo dispositivo. Se la passphrase viene persa, non è recuperabile.
- **Concorrenza cloud**: OneDrive usa eTag/If-Match e If-None-Match:*. Google Drive v3 ha version checking con doppio lookup e rifiuto di duplicati, ma **NON garantisce CAS atomico**; due browser possono ancora inviare PATCH simultanee nell'intervallo critico. Finché non è disponibile un meccanismo lock/ETag verificato, non chiamare questo sync conflitto-free. La modifica remota non revoca il PAT: la revoca si fa manualmente su GitHub.

## Discovery repo e privacy

`github-discovery.ts` elenca solo metadata da GitHub, massimo 500 repository e risposta 1.5MiB/pagina (limitazione esplicita), supporta scelta manuale e usa `default_branch`. `permissions.push` indica privilegi dell'account, **non certifica lo scope effettivo del PAT** né regole branch. La prima pubblicazione chiede conferma privata/pubblica; `github-publication.ts` rilegge la visibilità effettiva di GitHub e blocca una repo pubblica senza consenso esplicito. Il PAT può essere riutilizzato per più progetti; `FactoryProject.githubDestination` separa gli owner/repo/branch per progetto. Il catalogo locale salva i progetti con ID individuale e limite 40, mai i segreti; resta necessaria una copia esterna in caso di quota browser/reset.

## Snapshot remoto e merge control

Una pubblicazione autorizzata invia i sorgenti generati più un file `.softwarefactory/workspace-state.v1.json` contenente **solo lo stato del progetto** (brief, stack, task output, workspace di sviluppo approvato e in bozza) con limite dimensioni e controllo di pattern sensibili. Il checkpoint è un artefatto **deliberatamente leggibile da chi può leggere la repository**; non è un vault. Non includere chiavi API nei requisiti o nei log di review.

Prima del push vengono verificati il branch HEAD corrente e, se presente, l'ultimo SHA attestato localmente. Per un primo push, se la repository contiene già un checkpoint SoftwareFactory, è obbligatoria un'importazione esplicita prima di procedere. L'aggiornamento Git Data usa base tree + commit e ref PATCH con `force:false` e condizione `expectedHead`; non fa merge/force push. Se si perde la risposta di un commit, il successivo sync non salta il controllo HEAD: l'utente deve verificare e riconciliare manualmente. Se il commit è confermato, `githubSync.lastCommit` viene registrato assieme alla revisione locale. L'importazione remota valida schema e path del workspace, richiede consenso per sostituire il progetto aperto, e disabilita autosync sul nuovo dispositivo. È un restore manuale, non un merge di due codici divergenti.

## Autosync opt-in

Dopo primo commit confermato, l'utente può autorizzare autosync. Finché la pagina è aperta e visibile, ogni 15s il browser controlla se il workspace è cambiato: commit minimo a 120s dall'ultimo successo; usa Web Locks tra schede, verifica snapshot localStorage prima di inviare, e mantiene un outbox locale **solo di metadati** (nessun token o file). Se un altro dispositivo ha avanzato la HEAD o la scheda ha cambiato progetto, il tentativo è bloccato senza sovrascrittura. Errori transienti hanno retry limitato con backoff, solo pagina aperta. Se fallisce la scrittura ma GitHub può aver creato il commit, l'assenza di ack locale rende il prossimo tentativo un conflitto — non un nuovo push indistinto.

**Limiti**: Web Locks copre schede dello stesso browser/ambiente, non è un lease transazionale tra diversi dispositivi. Il protocollo è conservativo e non garantisce serializzabilità globale o rilascio sicuro durante crash. L'outbox non replica file, ma il checkpoint resta nel database browser. L'autosync si basa sul timestamp `updatedAt`: non sostituisce revisione monotona/CAS piena in IndexedDB. L'utente deve esportare backup prima di import e conflitti.

## GitHub Actions e fix

La modalità Actions (#90) testa soltanto il commit effettivamente pubblicato (UUID/runId/sha/attempt). Il pulsante per preparare un fix in Code Agent resta disabilitato se `githubSync.lastCommit != report.commitSha` o se `syncedLocalUpdatedAt != project.updatedAt`, o una proposta è già pending. I log rimangono dati non fidati, nessun LLM viene invocato al click di preparazione, nessuna patch viene approvata/pubblicata senza review e nuovi test. I test reali su PAT e browser CORS sono ancora da effettuare.

## Attività ancora aperte

- Test E2E con PAT fine-grained su repo privata/public e OneDrive/Drive OAuth reali, preferibilmente due browser/dispositivi.
- CAS atomico verificabile per Google appDataFolder, eventuale lease multi-device opzionale e rotazione/revoca cloud di un PAT.
- Import GitHub ricostruito da repo **senza** checkpoint legacy: ora richiede un checkpoint v1; occorre migrazione opzionale del vecchio manifest.
- Test di browser per connessioni cloud, ricaricamento IndexedDB CryptoKey e gestione conflitti/outbox, oltre ai Vitest con mock.
- i18n centralizzato completo di tutte le sezioni: alcune sezioni storiche e messaggi operativi dei nuovi pannelli sono ancora localizzati inline.
- Connettività cloud solo sessione OAuth finché non scade; installazione VM/Release ancora #87/#90.

## Audit di sicurezza successivo — #92

- **Consenso repository PUBLIC**: `githubSync.publicConsent` può essere riutilizzato SOLO se `githubBindingMatches(project, git)` identifica esattamente la stessa owner/repo/branch. Se GitHub segnala una repository pubblica nonostante l'impostazione «crea privata», l'interfaccia chiede un secondo consenso prima del primo push; non vengono inviati sorgenti prima della conferma.
- **Nessuna attestation trasferibile**: `portableGithubProject` elimina da checkpoint e import `lastRunnerJobId`, `lastRunnerEvidence`, `pending.review`, `pending.repairSession` e `pending.repairTrail`. Il codice e il testo della proposta rimangono per ripresa, ma una vecchia verifica su un altro dispositivo non autorizza nuove approvazioni. Un repair importato può richiedere lo scarto della proposta e una nuova generazione, non una approvazione implicita.
- **ACK remoto esatto**: `pushGeneratedFiles` richiede che il ref `PATCH force:false` restituisca lo SHA del commit appena creato E una lettura successiva di `git/ref/heads/` confermi quello stesso SHA. Se il ref si è mosso, il commit può esistere ma **non è dichiarato sincronizzato localmente**; recupero solo con verifica HEAD.
- **Confronto e backup**: `compareGithubWorkspaces` produce elenco limitato dei path divergenti della snapshot generata senza mutare file; l'UI mostra differenze, progetto/HEAD/bozze prima della sostituzione. Se c'è divergenza o progetto differente, viene predisposto un backup JSON locale scaricabile e serve un secondo assenso esplicito prima di importare. Il download non è una prova automatica che l'utente abbia salvato il file.
- **Conflitto locale multi-tab**: `persistProjectIfUnchanged` confronta la serializzazione della copia per-project con la baseline conosciuta nella scheda, l'UI ascolta `storage` e interrompe modifiche/publish/AI/AUTOSYNC se trova una copia diversa. Un pulsante chiede backup e consenso prima di caricare la copia della libreria. Questo NON è un CAS atomico inter-documento (localStorage può avere una gara fra check e write in processi distinti), né un lease remoto: per garanzie più forti serviranno IndexedDB transazioni e lock cross-tab completi o un coordinatore server. Non dichiarare questa mitigazione equivalente alla sicurezza concorrente di BookWriter.
- **Actions**: i log di un report non autenticato da provenance cloud non autorizzano mai test pass/fix automatici; il prefill per Code Agent è già bloccato salvo SHA esatto e workspace locale invariato.

Test unitari `github-parity.test.ts`, `github-publication.test.ts`, `github-diff.test.ts`, `github-pat-device.test.ts`. Collaudi reali GitHub PAT, Google/OneDrive, due browser, CORS e resume restano da certificare, come `#91`.
