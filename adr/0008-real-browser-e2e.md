# ADR 0008 — Playwright browser reale per gli scaffold React

- Data: 2026-11-14
- Stato: accettato per baseline E2E, non certificazione di produzione
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/5
- Dipendenze: ADR 0005, 0006, 0007

## Contesto

Il runner sapeva pianificare uno step Playwright ma nessuno scaffold aveva config o spec browser. La precedente CI non lanciava Chromium. Un successo dei test Node non provava rendering, esecuzione JavaScript o reazione della UI alle risposte API.

## Decisione

1. Generare `src/frontend/web/playwright.config.ts` con `webServer` di Vite su loopback `127.0.0.1:4173`, timeout e solo progetto Chromium.
2. Fornire `e2e/smoke.spec.ts` con due prove reali della UI: API healthy e unavailable; interporre mock di `/health` perché l'obiettivo è il funzionamento della UI e non dipendere da servizi esterni durante un test di base.
3. Usare la stessa versione pinata `@playwright/test=1.64.1` e immagine browser `mcr.microsoft.com/playwright:v1.64.1-noble`. Lo step Playwright rifiuta versioni incompatibili e requisiti mancanti.
4. Avviare il browser attraverso il percorso effettivo `planStep → runDockerStep`, senza accesso a rete Internet, con lo stesso container che serve Vite localmente. Test reali nella CI di SoftwareFactory, separati dalle prove simulate dell'API runner.
5. Fare in modo che la CI generata installi Chromium e lanci lo smoke E2E dopo il build frontend, bloccando il job quando i test falliscono.

## Perché il mock API non è un falso test

Le interazioni e le asserzioni vengono eseguite da Chromium reale. Si verifica solo la UI e il contratto di risposta simulato. Il test non pretende di provare disponibilità dell'API in .NET o transazioni DB, che richiederanno un ambiente d'integrazione con rete privata e fixture esplicite.

## Limiti e sicurezza

- Il browser ufficiale Playwright include le dipendenze di sistema, non `@playwright/test`: lo installa la fase npm preparatoria.
- Il browser può richiedere opzioni di processo/sandbox specifiche sul daemon rootless, ancora da collaudare in VM isolata.
- Gli artefatti di errore contengono screenshot e tracce potenzialmente sensibili: retention CI limitata e nessun token nelle fixture.
- Un Docker runner su GitHub effimero non prova la sicurezza di un host on-prem né l'isolamento di un multi-tenant.
- Per test con API/database reali vanno introdotte reti locali controllate; non aprire Internet ai container che eseguono codice AI.
