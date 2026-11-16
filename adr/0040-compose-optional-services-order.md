# ADR 0040 — Emissione corretta di services/volumes e management ports locali

- Data: 2026-11-16
- Stato: accettato nel generatore
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/83
- Follow-up: https://github.com/KeyserDSoze/SoftwareFactory/issues/82
- Epica: https://github.com/KeyserDSoze/SoftwareFactory/issues/9

## Contesto

La nuova validazione `docker compose config --format json` del Compose generato per la #82 ha trovato un difetto reale: il generatore aggiungeva la root YAML `volumes:` immediatamente dopo il database PostgreSQL, MySQL o SQL Server; i servizi opzionali Redis, RabbitMQ, Jaeger e MinIO erano aggiunti dopo, e quindi interpretati come voci di `volumes`. Per il progetto di default il parser Compose ha rifiutato `volumes.jaeger additional properties 'image', 'ports' not allowed`. La correzione deve valere per tutte le varianti, non soltanto per il progetto che ha fallito il test.

Inoltre le porte RabbitMQ management (15672), Jaeger UI (16686) e OTLP (4317) erano pubblicate su tutte le interfacce, in contrasto con la #82, che limita API/Web al loopback per i demo senza TLS.

## Decisione

1. Calcolare separatamente il `namedVolume` richiesto dal database selezionato (`pgdata`, `mysqldata`, `sqlserverdata`, oppure nessuno per SQLite). Generare prima **tutti** i blocchi di servizi dentro `services:`, compresi quelli opzionali; solo alla fine aggiungere la dichiarazione YAML top-level `volumes:`, se presente. I mount per i database rimangono invariati.
2. Bindare esplicitamente `127.0.0.1` su RabbitMQ management 15672, Jaeger 16686 e OTLP 4317 nel Compose generato, come già previsto per API e Nginx. L'accesso pubblico richiede un reverse proxy/protezione separata.
3. Aggiungere test Vitest sui quattro database con tutti i servizi opzionali, controlli strutturali e **rendering effettivo** con `docker compose config --format json` in CI. Verificare sia named volumes e servizi sia l'host IP dei port pubblicati, usando un env con sole credenziali fittizie; non eseguire o scaricare immagini durante i test.

## Conseguenze e limiti

Il rendering Compose reale costituisce una verifica della validità dello YAML e dello schema e delle variabili interpolate, non un test di salute Docker per servizi opzionali o un deployment HTTPS esterno. Vincolare le console e OTLP al loopback cambia l'accessibilità remota: per un ambiente distribuito serve un overlay/reverse proxy autenticato esplicitamente configurato. La CI esegue ancora solo Docker rootful su runner effimero e un provider OIDC simulato, non certifica IdP/Cloudflare/VM rootless. L'epica #9 rimane aperta.
