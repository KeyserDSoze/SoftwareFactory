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
