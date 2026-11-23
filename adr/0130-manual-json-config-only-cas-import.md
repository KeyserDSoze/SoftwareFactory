# ADR 0130 — import manuale configuration-only JSON verso CAS nativo (#178/#139)

## Decisione

Il workspace radice \`?workspace=cas\` può ricevere un JSON progetto scelto **manualmente** dall'operatore (fino a 1 MB) solo quando non è già selezionato un progetto. Nessun URL, localStorage, GitHub, cloud, parser remoto o job viene consultato. La lettura del file non avvia né modifica pipeline.

Un progetto esterno non porta attestazioni verificabili: il parser richiede JSON **canonico**, identità e stage coerenti, whitelist schema e configurazione completa con stack valido e senza credenziali note. Si ricava un **nuovo UUID** tramite createProject e si copia **solo** la configurazione (inclusi brief/requirements e binding ambienti), con suffisso \`(import)\`. Tutti i sei stage ripartono \`pending\` e vengono omessi development, Code Agent, runner, GitHubSync, test receipt, consensi e destinazioni GitHub.

L'utente deve confermare espressamente il nuovo ID. La scrittura usa una sola \`compareAndSwapCasProject(target,null)\`, che respinge collisioni (incluse tombstone), capacità oltre 40, quota e storage indisponibile in una transazione IndexedDB; ACK solo a \`tx.oncomplete\`. Nessun retry automatico con nuovo UUID dopo errore, che potrebbe aver confermato la scrittura; una rilettura successiva è solo osservazionale. L'interfaccia non apre automaticamente la nuova copia.

## Limiti e verifiche

Si tratta di un **nuovo progetto pulito**, non di restore storico o migrazione live; il backup originale rimane intatto e deve essere conservato. I vecchi writer legacy e i dispositivi remoti non condividono la CAS nativa. Non rivendicare parità o sicurezza multi-device, né test/approvazioni preesistenti. La baseline #139/#91/#92 resta aperta.

Vitest \`cas-external-config-import.test.ts\` prova schema/size/segreti, reset prove, ticket manomessi, consenso e native insert-only/fault. Il gate complessivo rimane Factory CI, Pages e Installer candidate sullo stesso commit.
