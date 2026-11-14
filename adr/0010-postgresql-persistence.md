# ADR 0010 — Persistenza PostgreSQL e test reale del ciclo HTTP/DB

- Data: 2026-11-14
- Stato: accettato per scaffold demo e CI, non per produzione
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/7
- Dipende da ADR 0008, 0009

## Contesto

La CI poteva verificare la comunicazione React↔API ASP.NET Core ma l'infrastructure layer dichiarava solo `PersistenceOptions`, senza backend persistente. Questo impediva di testare il comportamento dei dati e poteva generare false aspettative sulle opzioni provider.

## Decisione

1. Generare un adapter soltanto per `postgresql`, usando Npgsql 10.0.3 pinato, connessioni da `NpgsqlDataSource` singleton e repository SQL con parametri tipizzati. Il dominio definisce `WorkItem`/`IWorkItemRepository`, il business layer `WorkItemService`, la API minimale i percorsi GET/POST/PUT/DELETE.
2. Applicare la migrazione SQL `0001_create_work_items.sql` come embedded resource. Il migrator inserisce un record nella tabella `factory_schema_migrations` sotto advisory lock e transazione per impedire doppie migrazioni e garantire ordine. Non creare tabelle casualmente ad ogni request.
3. La connessione viene letta solo da `Database:ConnectionString` (variabile `Database__ConnectionString`) e iniettata esternamente. Se assente, avvio fallito, non fallback silenzioso. Il Docker Compose generato riceve `DB_PASSWORD` dalla env locale, e PostgreSQL espone la porta host solo su loopback.
4. Nella CI dello scaffold usare un PostgreSQL temporaneo con password effimera, readiness e teardown; nella CI Factory estendere il bridge privato con un container PostgreSQL e verificare tramite Chromium un create/list/delete con controllo dalla API vera.
5. Nessuna modifica di backend/prodotto è applicata da un AI agent senza review. La rete privata e l'uso di Docker Engine host sono circoscritti alla CI effimera.

## Tradeoff e lavoro futuro

- Npgsql richiede restore NuGet controllato prima di build isolati offline; la preparazione della cache NuGet del runner remoto resta aperta.
- Migrazioni forward-only e singola tabella demo, non EF Core completo né rollback automatizzati.
- Le API /api/items sono volutamente senza auth, rate limit e tenant isolation: servono identity/authz e limitazione delle autorizzazioni prima del rilascio.
- Solo PostgreSQL dispone di un adapter reale. Le configurazioni MySQL, SQL Server e SQLite continuano a essere placeholder.
- Il database Postgres nella CI non dimostra backup, failover, resilienza, compliance o isolamento multi-tenant di produzione.
