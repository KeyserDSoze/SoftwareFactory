# SoftwareFactory Runner Installer

Preliminary operator-executed installer bundle for dedicated Ubuntu/Debian hosts.
This release is **experimental**, not certified for production systems.
No secrets, PATs, Cloudflare credentials or private data are bundled.

**Files:**
- `softwarefactory-runner-installer.tar.gz`: source bundle (includes installer script, Docker Compose, API/worker and bilingual guides)
- `softwarefactory-runner-installer.tar.gz.sha256`: archive integrity checksum

**Verify before extracting:** `sha256sum -c softwarefactory-runner-installer.tar.gz.sha256`

Instructions: [Italiano](https://github.com/KeyserDSoze/SoftwareFactory/blob/main/INSTALLER.it.md) · [English](https://github.com/KeyserDSoze/SoftwareFactory/blob/main/INSTALLER.en.md).

**Important:** Requires Node.js 22, sudo and a dedicated Ubuntu/Debian uid 1000 account. Run `node src/runner/scripts/interactive-install.mjs` locally. This is not a GitHub Pages browser executable; review on-host security and manually test reboot, Cloudflare Tunnel and Access.

## Verified-source manifest in RC.2+

The installer package includes `.sf-installer-source.json`, generated from the **exact source commit** by the GitHub Release workflow. It contains the source commit SHA and the SHA-256 digest of every shipped source file. The operator must compare the archive's published SHA-256 against the downloaded bytes **before extraction**, retain the original archive, and approve the full source commit SHA and immutable `node@sha256:<digest64>` canary image when running `interactive-install.mjs`.

**Security change:** the previous `v0.2.0-rc.1` wizard started Compose services without #88's full canary acceptance and cannot pass the new archive manifest contract. **Do not use rc.1 for new installations.** The wizard now uses `host-install --apply --confirm-install` for rootless Docker and authenticated service readiness, then allows Cloudflare tunnel startup as a *separate, gated* operation. Package hashes are integrity checks, not independently authenticated signatures. A real Ubuntu/Debian VM, reboot and external Tunnel/Access test are still required before production use.

## Operator post-reboot check (experimental, #96)

After rootless runner installation on the dedicated Linux UID1000 host, use node src/runner/scripts/host-reboot-audit.mjs before --env-file=/absolute/path/docker/runner/.env --require-tunnel, physically reboot, then repeat using after. The private local witness records the kernel boot ID and expected services without secrets. A result after reboot checks systemd Docker user/linger, rootless Compose containers and authenticated readiness. This is NOT proof of Cloudflare DNS/Access/TLS or a signed off-host attestation; a real host reboot and second-device browser test remain necessary.
