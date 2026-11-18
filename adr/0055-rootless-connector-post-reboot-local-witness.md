# ADR 0055 — Local reboot witness for the rootless connector

- Date: 2026-11-18
- Status: accepted for local operator-only observation, not a rootless VM certification
- Issue: https://github.com/KeyserDSoze/SoftwareFactory/issues/96
- Parents: #87 M2, #2, #89, #90
- Prior: ADR 0044 host installer and ADR 0054 canary-first Release

## Context

A GitHub-hosted CI Docker daemon is rootful and cannot certify that an actual Linux VM running the SoftwareFactory connector survives a physical reboot. An unauthenticated healthz or a Cloudflared container status is insufficient to prove runner readiness or a genuine boot transition.

## Decision

1. Add a Linux UID/EUID1000 **operator-only** before/after CLI. No Docker creation, startup, deletion, shell eval, SSH, public HTTP or credentials in argv.
2. Each mode requires a verified O_NOFOLLOW private env, Compose and rootless host preflight, systemd user docker.service active and loginctl linger=yes, an independent Docker rootless check before every ps/inspect, and exactly two nonprivileged Compose containers (API and worker) with canonical project labels, project-private network, API bound to 127.0.0.1:8787 and rootless host socket mounted only in the worker. Optional --require-tunnel requires exactly three services including Cloudflared without socket or public binding, **not** live public ingress.
3. Reuse the authenticated loopback probe. Without Bearer, capabilities must return 401; with validated private Bearer, capabilities, worker readiness and execution readiness must confirm rootless and a responsive worker. Detect env rotation and boot ID change during a run; never echo secrets.
4. Only after these checks BEFORE writes a single O_EXCL/O_NOFOLLOW local witness in private RUNNER_DATA_DIR mode0600 (schema, kernel boot UUID, timestamp, required services and auth profile; no tokens). AFTER reads it with owner/mode/nlink and size checks, refuses malformed, expired (over 7 days), wrong-profile or same-boot evidence, then repeats every live observation and emits a **local-only** receipt.
5. Test Node mocks for reboot, systemd, Docker and API plus real filesystem witness tests for no-overwrite/symlink/hardlink/permissions; Factory CI remains rootful and cannot attest a Linux VM reboot. Operator must separately test HTTPS/DNS/Access/CORS from another device.

## Limits

Boot ID, witness and Docker state are locally observed and not TPM-backed, signed, remotely witnessed or independent of host admin control. A compromised UID1000/root may fabricate them. No claim of actual external Cloudflare Access, public TLS, host reboot certification, off-host attestation or multi-host fencing. Dedicated VM rootless live acceptance, credential rotation, update/uninstall, pairing and tenant security remain open.
