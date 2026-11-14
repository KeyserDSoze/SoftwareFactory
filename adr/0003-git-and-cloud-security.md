# ADR 0003 — Separazione GitHub, OAuth cloud e segreti

- Stato: accettato per MVP
- Data: 2026-11-14

PAT minimalmente autorizzati oppure GitHub App mediata da backend broker. Niente private key App nella SPA. GitHub Git Data API con commit in fast-forward; main per default e branch alternativo esplicito. Backup su Google Drive appDataFolder e Microsoft Graph OneDrive approot con OAuth PKCE, scope ristretti e token in sessionStorage. Le credenziali non entrano nel manifest. Per uso enterprise servono threat model, XSS-hardening, session management e servizio backend dedicato.
