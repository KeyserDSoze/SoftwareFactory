# ADR 0050 — Idempotenza della sessione OIDC nel frontend generato

Data: 17 novembre 2026 · Stato: **fix in verifica CI** · Issue [#93](https://github.com/KeyserDSoze/SoftwareFactory/issues/93), correlata a [#9](https://github.com/KeyserDSoze/SoftwareFactory/issues/9).

## Problema osservato

La CI sulla SHA `3ef3f2bd92abc8a9b74846060e2197ad9654d3d8` ha passato tutti i test browser Factory/multi-tab e 17/18 scenari della suite React↔ASP.NET Core/OIDC/PostgreSQL; lo scenario CRUD inserimento elemento non ha visto comparire in UI la nuova riga dopo il click `Aggiungi` (`src/frontend/web/e2e/smoke.spec.ts:61`, run 44147512726, primo tentativo). **Il rerun di quel medesimo SHA è riuscito**, quindi il problema è intermittente e non dimostra, da solo, che la POST sia fallita o che il database fosse indisponibile. Non nascondere né far passare automaticamente il test.

L'implementazione generata di `WorkItems.tsx` riceve notifiche concorrenti di stato da `UserManager.events.userLoaded` e dal completamento della redirect callback OIDC. In precedenza `switchSession(token)` incrementava sempre `sessionEpoch`, svuotava `items` e annullava in modo logico qualunque risultato HTTP in volo, **anche quando il nuovo token era identico a quello attivo**. Quindi due notifiche equivalenti potevano far ignorare l'ack di una POST valida. È una spiegazione plausibile per l'intermittenza, non una root cause dimostrata per ogni esecuzione fallita.

## Decisione

- `switchSession(nextToken)` non modifica né `sessionEpoch` né lo stato quando `nextToken` è **non vuoto e identico** al token già attivo e non esiste un logout fence.
- Transizioni significative (identity/token change, logout, revoca, 401, altre schede) continuano a incrementare l'epoch e invalidare operazioni e risposte tardive. Il `logoutFence` ha sempre la precedenza.
- Il test E2E PostgreSQL generato attende esplicitamente la risposta **POST /api/items** della UI, controlla `response.ok()` e poi la presenza del nuovo elemento. In caso di fallimento registra status HTTP, non contenuti o Bearer token. Non si aggiungono retry ciechi, screenshot di credenziali, `continue-on-error` o `test.skip`.
- Un test di generazione verifica l'idempotenza e la prova HTTP; la Factory CI completa riprova la vera integrazione in Chromium/Docker/PostgreSQL/OIDC.

## Limiti

Il rerun verde di un fallimento intermittente non è un certificato di assenza di race. Per chiudere #93 servono un'esecuzione verde del **nuovo** SHA e idealmente più cicli della suite, raccolta di metadata non sensibili per un eventuale ulteriore fallimento e test stress di callback duplicate. Il controllo non pretende di validare IdP esterni o browser/dispositivi reali.
