# ADR 0087 — Limiti byte pre-parse sugli stream del provider AI nella SPA

**Data:** 2026-11-20  
**Issue:** #133 (progresso tecnico a #109)  
**Stato:** accepted come limitazione risorse client; non attestation.

## Contesto

Il client React local-first eseguiva `Response.json()` senza bound prima dei controlli semantici su `choices`, `finish_reason`, `usage` o sulla lista `/models`. Un server AI OpenAI-compatible, proxy o gateway difettoso o malevolo può restituire un documento enorme che blocca o esaurisce le risorse browser, anche quando la validazione logica successiva lo respinge.

## Decisione

Usare un unico `readBoundedProviderJson` sui Response HTTP di `aiComplete` e `discoverAiModels` con limiti distinti di **4 MiB** per completion e **512 KiB** per inventario modelli. Il parser verifica `Content-Length` canonico quando presente come early rejection, ma non se ne fida: aggrega soltanto chunk `Uint8Array` fino alla soglia, misura i byte del corpo *decodificato dal browser* e rigetta prima di allocare il buffer completo o chiamare `JSON.parse` se supera il limite, anche con header assente o falso. `TextDecoder` con UTF-8 fatal, JSON error senza contenuti raw. Il reader viene cancellato su ogni failure e il lock viene rilasciato. Nessun retry automatico per evitare richieste forse fatturabili duplicate.

Per mantenere compatibilità con i mock degli attuali test unitari senza Response.body, la lettura nonstreaming `text()`/ `json()` deve verificare il bound **prima di interpretare il JSON** quando possibile; i mock `json()`-only sono un'eccezione non valida per asserire sicurezza di consumo memoria da una rete reale. Il controllo `completedAiText` (#132) rimane successivo alla protezione delle risorse; il contatore volatile `provider_reported_unverified` non viene emesso in caso di risposta respinta.

## Conseguenze e limiti

Un prompt/code patch che produce più di 4 MiB va suddiviso; i cataloghi maggiori di 512 KiB vanno paginati dal provider o da un gateway. Questi limiti proteggono solo una risposta, non la dimensione delle richieste, il tempo di esecuzione, la fiducia della chiave provider, la correttezza dei token o la fatturazione. `Content-Length` può essere compresso/non affidabile: la misura del body *effettivamente letto* resta decisiva. Test Vitest realistici con ReadableStream e Response non contattano il provider. #109/#113 continuano aperte.
