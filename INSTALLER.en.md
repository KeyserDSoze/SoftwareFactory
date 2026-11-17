# SoftwareFactory Linux Runner Installer — English

Download the installer from the [GitHub Releases page](https://github.com/KeyserDSoze/SoftwareFactory/releases), or from **SoftwareFactory → Settings → Runner**. The app is hosted on GitHub Pages, so the installer must run **locally on your server**; the site cannot run shell commands on your computer. This package is experimental and intended for a dedicated Ubuntu/Debian VM.

## 1. Download and verify

Download **both** `softwarefactory-runner-installer.tar.gz` and `softwarefactory-runner-installer.tar.gz.sha256` to the same folder:

```bash
sha256sum -c softwarefactory-runner-installer.tar.gz.sha256
tar -tzf softwarefactory-runner-installer.tar.gz | head
tar -xzf softwarefactory-runner-installer.tar.gz
cd softwarefactory-runner-installer
```

Stop if the check fails. A checksum from the same release detects download corruption but is not independent proof of publisher identity.

## 2. Server prerequisites

Use a **dedicated Ubuntu/Debian Linux VM**, an unprivileged account with **UID 1000**, Node.js 22, Git, sudo and an interactive terminal. The wizard **does not** install Node.js or create your Linux account. Existing rootful Docker service is refused. Do not run on shared or sensitive hosts.

## 3. Cloudflare setup

In the Cloudflare Dashboard open **Networking → Tunnels**, create a tunnel and copy its connector token. You need a Cloudflare-managed domain and a public HTTPS hostname such as `runner.example.com`. Configure identity/Access policies so your browser can reach the API, including CORS `OPTIONS` preflight.

## 4. Run the installer locally

```bash
node src/runner/scripts/interactive-install.mjs
```

Type **INSTALLA** to approve privileged package installation. The wizard asks for the exact GitHub Pages origin (e.g. `https://keyserdsoze.github.io`, not the project path), your server HTTPS URL, a **hidden-input Cloudflare token** and a randomly generated or custom runner API key of at least 32 characters. Cloudflare token stays on the server.

Docker rootless is enabled with `systemctl --user` and `loginctl enable-linger 1000`, while the runner and cloudflared containers restart automatically. The API listens on host loopback `127.0.0.1:8787`.

## 5. Publish the tunnel route

In **Networking → Tunnels → Routes → Add route → Published application**, set service type **HTTP** and service URL **`http://runner-api:8787`** for the chosen public hostname. **Do not set `localhost:8787`**, which would point to the cloudflared container itself. In SoftwareFactory Settings, enter the HTTPS URL and the **runner API key only**, then verify connectivity.

## 6. Check reboot and security

Actually reboot your VM and verify `systemctl --user status docker`, runner container readiness and HTTPS access. Run an approved test and inspect its report. Full Ubuntu/Debian, reboot and Cloudflare Access validation is not yet certified. The current Compose tunnel token can be inspected by host Docker administrators; keep all host credentials private. Read [docs/runner.md](docs/runner.md) before upgrading or uninstalling. Do not rerun the installer on an existing installation.
