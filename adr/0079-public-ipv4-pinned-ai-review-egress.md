# ADR 0079 — Connessione Code Reviewer con IPv4 pubblico e lookup pinned sulla socket TLS

**Data:** 2026-11-20  
**Issue:** #125 (security fix della #123, milestone #113)  
**Stato:** accepted come protezione egress DNS, non come autenticazione del provider o attestation.

## Vulnerabilità

La #123 ha aggiunto la possibilità esplicita di inviare i sorgenti testati e un'API key a un endpoint HTTPS del provider. Il validatore URL nega IP letterali, \`localhost\`, URL non TLS, credenziali e query, ma la \`fetch\` reale risolve il hostname autonomamente, **dopo** la validazione. Qualunque hostname con sintassi pubblica potrebbe risolversi via DNS a loopback, metadata service, RFC1918 o CGNAT, e la TLS call tenterebbe l'IP destinato da DNS. Un eventuale controllo DNS preventivo senza vincolo alla socket lascerebbe un classico problema di DNS rebinding/TOCTOU.

## Decisione

Introdurre \`src/runner/provider-egress.mjs\` come unico trasporto reale della CLI \`ai-review-execute.mjs\`. \`validatePublicProviderEndpoint\` mantiene la policy di URL HTTPS non ambiguo. Con \`dns.promises.resolve4\`, il client raccoglie record A IPv4 (1–32), **nega l'intera risposta** se un solo IP è privato, link-local, loopback, documentazione, multicast, riservato o otherwise special-use e usa il primo A convalidato **nello stesso** \`https.request\` tramite la proprietà \`lookup\`. Evita quindi qualsiasi secondo lookup DNS di default prima del connect. La socket non usa un agent condiviso (\`agent:false\`); i certificati HTTPS sono verificati (\`rejectUnauthorized:true\`, \`checkServerIdentity\` e \`servername\` originali), senza seguire redirect, proxy di libreria o fallback HTTP. Il deadline di 30s include DNS, handshake e streaming fino ai 64KiB massimi; 4xx/5xx/3xx, body troppo grande/troncato o errori TLS/DNS sono fail-closed e **non** si effettua retry automatico.

Non utilizzare un URL o un IP proposto da un modello come trust anchor. La pipeline non importa il nuovo modulo; la CLI continua a richiedere consenso specifico e keyfile privato (FD \`O_NOFOLLOW\`, modo 0600). Per non rompere i test di #123, \`executeAiReview({fetchImpl})\` conserva una injection esplicitamente riservata ai test con un mock: \`main\` non espone un flag di trasporto iniettato e il trasporto predefinito è sempre pinned. Test automatici con fake A resolver, fake \`https.request\`, TLS opzioni, DNS misto/privato, errori/redirect, deadline e overflow non contattano Internet.

## Tradeoff, limiti e residui

Il nuovo trasporto è **IPv4-only**: endpoint senza A pubblico falliscono invece di essere inviati a un AAAA non verificato. Una zona DNS valida ma indirizzata a un server pubblico controllato da un malintenzionato può comunque ricevere il codice se l'operatore la approva; TLS autentica il hostname, non l'identità commerciale del fornitore. Nessuna DNSSEC, pinning degli indirizzi tra esecuzioni, trust registry di provider o prova di provider billing. Operator Ed25519 receipt #123 resta soltanto la dichiarazione dell'operatore, non una firma del provider. Per ambienti multi-host o con sorgenti ad alta sensibilità utilizzare firewall/egress allowlist e consenso gestito. #113/#109/#105 rimangono aperte.
