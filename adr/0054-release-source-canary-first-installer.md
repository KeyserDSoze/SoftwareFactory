# ADR 0054 — Release-source verification and canary-first installer

- Date: 2026-11-18
- Status: accepted for experimental Linux installer, not externally certified
- Security bug: https://github.com/KeyserDSoze/SoftwareFactory/issues/95
- Parents: #87, #89, #90 and rootless runner #2
- Prior: ADR 0044 (Linux host installer), ADR 0046 (wizard + resource metrics)

## Context

The operator wizard \`interactive-install.mjs\` installed Docker packages and
then invoked \`host-setup.mjs start --tunnel\`, which ran only preflight
\`host\`/\`compose\` before \`docker compose up\`. It skipped the more complete #88
\`host-install\` canary, exclusive lock, Docker socket verification, authenticated
readiness and in-flight configuration rechecks. The already published RC.1
installer used a \`git archive\` without \`.git\`, so the #88 installer could not
verify a clean Git main checkout from the downloadable tarball.

## Decisions

1. The legacy \`host-setup start\` command now **refuses** and never starts
   containers, even when called with \`--tunnel\`. The wizard requires operator
   approval before apt/sudo of a full source SHA-40 and immutable Node canary
   image digest; it must use \`host-install --apply --confirm-install\` to start
   API/worker, with all existing #88 protections intact. No rootful fallback.
2. A Git checkout is still verified through Git main/clean/pinned HEAD. For
   a Release archive, the workflow stages the exact Git archive and writes
   a deterministic \`.sf-installer-source.json\` recording SHA40 plus SHA256
   and size of each source file. A normal download from GitHub Pages/Release
   is verified by the **operator-approved archive SHA256**; a read-only
   \`tar -xOzf\` extracts only its manifest and verifies each file in the
   extracted directory, rejecting extras/symlinks/alterations. The private
   runtime \`docker/runner/.env\` is the only excluded extra and is read
   separately by the host's private-FD preflight. The original tar.gz is
   retained for re-verification at each execution gate.
3. RC.1 has no source manifest and its old startup path was unsafe: the
   static SPA must not recommend its asset. The next CI-approved candidate
   is RC.2 and must be verified before publication.
4. Cloudflared is a separate local \`host-setup tunnel --confirm-tunnel\`
   operation, available only after fresh rootless preflight, a private token
   check, authenticated runner capabilities/readiness and Docker rootless
   verification. It starts **only** the cloudflared Compose service with
   minimal process environment and cannot start API/worker. No automatic
   cleanup/prune, DNS/Access assertion or tunnel token in the browser.
5. Add deterministic Node tests (Git/Release plan, checksum/source hashing,
   file mutation, symlink, source drift at multiple gates, tunnel refusal),
   runner syntax/Factory CI, i18n release guidance, and a CI-approved RC
   publish workflow which packages and self-verifies the tarball.

## Trust boundaries and limitations

A SHA256 published beside its tarball is an integrity check against download
corruption and accidental local tampering, **not an independently signed
publisher attestation**. If a GitHub account or Release is compromised, the
manifest can be replaced together with its checksum. Pin the reviewed release
commit and inspect provenance independently before privileged installation.
The host checks source/configuration at points in time, not atomically across
an untrusted host. Rootless Docker's socket is still powerful to the worker.
GitHub CI Docker is rootful even if syntax and canary mocks pass; this ADR
does not certify a real Linux host reboot, kernel isolation, Cloudflare Access
or external OIDC. #87/#89/#90/#2 remain open for those validations.
