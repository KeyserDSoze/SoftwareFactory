/**
 * Operator-local interactive Linux installer (issue #89).
 * Explicit sudo consent; NO web/SSH execution, no curl|bash, no shell strings,
 * no API key or Cloudflare token in argv/logs. Runs only as dedicated uid 1000.
 *
 * Docker Engine comes from Docker's signed apt repository after a pinned GPG
 * fingerprint check. Cloudflared runs in the reviewed Compose as a restartable
 * container service, connected only to the runner-api private Docker network.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import https from "node:https";
import { validateFactoryOrigin, validateCloudflareToken, validateOperatorApiKey,
  writePrivateHostConfig, envFile, repoRoot } from "./host-setup.mjs";
import { verifyCleanPinnedMain } from "./host-install.mjs";
import { verifyInstallerReleaseSource } from "./installer-source.mjs";

const FINGERPRINT = "9DC858229FC7DD38854AE2D88D81803C0EBFCD88";
const DOCKER_REPO_KEY = "/etc/apt/keyrings/softwarefactory-docker.asc";
const DOCKER_REPO_LIST = "/etc/apt/sources.list.d/softwarefactory-docker.list";
const distroHosts = new Set(["ubuntu", "debian"]);
const archs = new Set(["amd64", "arm64"]);
const packages = [
  "docker-ce", "docker-ce-cli", "containerd.io",
  "docker-buildx-plugin", "docker-compose-plugin", "docker-ce-rootless-extras",
  "uidmap", "slirp4netns", "dbus-user-session", "fuse-overlayfs",
];
const DOCKER_HOST = "unix:///run/user/1000/docker.sock";

export function parseLinuxDistro(raw) {
  if (typeof raw !== "string" || raw.length > 8192) throw Error("Distribuzione non valida.");
  const dict = Object.fromEntries(raw.split(/\r?\n/).map(line => {
    const m = line.match(/^([A-Z_]+)=("?)([a-z0-9._-]+)\2$/);
    return m ? [m[1], m[3]] : [null, null];
  }).filter(([k]) => k));
  if (!distroHosts.has(dict.ID) || !/^[a-z]{3,15}$/.test(dict.VERSION_CODENAME ?? ""))
    throw Error("Installer automatico disponibile soltanto su Ubuntu/Debian supportato.");
  return { id: dict.ID, codename: dict.VERSION_CODENAME };
}
export function validatePublicRunnerUrl(raw) {
  if (typeof raw !== "string" || raw.length > 240) throw Error("Dominio runner non valido.");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.origin !== raw || url.username || url.password ||
      !/^[a-z0-9.-]+$/i.test(url.hostname) || url.hostname === "localhost")
    throw Error("Usare solo URL HTTPS pubblico del runner, senza path o credenziali.");
  return url.origin;
}
export function dockerRepoSource(distro, arch) {
  if (!distroHosts.has(distro.id) || !/^[a-z]{3,15}$/.test(distro.codename) ||
      !archs.has(arch)) throw Error("Distribuzione/architettura non supportata.");
  return "deb [arch=" + arch + " signed-by=" + DOCKER_REPO_KEY +
    "] https://download.docker.com/linux/" + distro.id + " " + distro.codename + " stable\n";
}
export function hasVerifiedDockerFingerprint(output) {
  return typeof output === "string" && output.split(/\r?\n/).some(line =>
    line.startsWith("fpr:") && line.split(":")[9]?.toUpperCase() === FINGERPRINT);
}
function runChecked(binary, args, { silent = false } = {}) {
  const result = spawnSync(binary, args, {
    cwd: repoRoot, stdio: silent ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: 240000, env: { ...process.env, DOCKER_HOST },
    encoding: "utf8",
  });
  if (result.error || result.status !== 0)
    throw Error("Comando di provisioning fallito: " + binary +
      ". Controlla repository apt, permessi o stato del sistema. Nessun rollback automatico.");
  return result.stdout ?? "";
}
async function downloadPublicKey() {
  const url = new URL("https://download.docker.com/linux/ubuntu/gpg");
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(Error("Firma Docker non scaricabile.")); return; }
      const chunks = []; let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > 65536) { req.destroy(Error("Keyring Docker troppo grande.")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => req.destroy(Error("Timeout repository Docker.")));
    req.on("error", reject);
  });
}
export async function provisionSignedDockerPackages({
  osRelease = () => readFileSync("/etc/os-release", "utf8"),
  run = runChecked, fetchKey = downloadPublicKey,
  keyLocation = DOCKER_REPO_KEY, sourceLocation = DOCKER_REPO_LIST,
} = {}) {
  const distro = parseLinuxDistro(osRelease());
  const arch = run("dpkg", ["--print-architecture"], { silent: true }).trim();
  const repoSource = dockerRepoSource(distro, arch);
  // Refuse to take over any pre-existing repo file.
  if (existsSync(keyLocation) || existsSync(sourceLocation))
    throw Error("Repository apt SoftwareFactory già configurato: verifica manualmente, non sovrascrivo.");
  run("sudo", ["apt-get", "update"]);
  run("sudo", ["apt-get", "install", "-y", "ca-certificates", "gnupg"]);
  const temp = mkdtempSync(join(tmpdir(), "sf-docker-apt-"));
  try {
    const key = join(temp, "docker.asc");
    writeFileSync(key, await fetchKey(), { mode: 0o600 });
    const fingerprint = run("gpg", ["--show-keys", "--with-colons", key], { silent: true });
    if (!hasVerifiedDockerFingerprint(fingerprint))
      throw Error("Docker GPG fingerprint diverso da quello previsto: installazione interrotta.");
    const source = join(temp, "softwarefactory-docker.list");
    writeFileSync(source, repoSource, { mode: 0o600 });
    run("sudo", ["install", "-d", "-m", "0755", "/etc/apt/keyrings"]);
    run("sudo", ["install", "-m", "0644", key, keyLocation]);
    run("sudo", ["install", "-m", "0644", source, sourceLocation]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
  run("sudo", ["apt-get", "update"]);
  run("sudo", ["apt-get", "install", "-y", ...packages]);
  return { distro, arch };
}
export function rebootServicePlan() {
  return [
    ["sudo", ["loginctl", "enable-linger", "1000"]],
    ["dockerd-rootless-setuptool.sh", ["install"]],
    ["systemctl", ["--user", "enable", "--now", "docker.service"]],
  ];
}
function assertDedicated() {
  if (process.platform !== "linux" || process.getuid?.() !== 1000 ||
      process.geteuid?.() !== 1000 || !process.stdin.isTTY || !process.stdout.isTTY)
    throw Error("Eseguire solo su Ubuntu/Debian come utente dedicato UID 1000 con terminale TTY.");
}
export async function hiddenPrompt(text) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode)
    throw Error("Serve un terminale locale TTY per l'input segreto.");
  process.stdout.write(text);
  const original = Boolean(process.stdin.isRaw);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      let value = "";
      const finish = (error) => {
        process.stdin.removeListener("data", onData);
        if (error) reject(error);
        else resolve(value);
      };
      const onData = (chunk) => {
        const input = String(chunk);
        for (const char of input) {
          if (char === "\u0003") { finish(Error("Input annullato.")); return; } // Ctrl-C
          if (char === "\r" || char === "\n") { finish(); return; }
          if (char === "\u007f" || char === "\b") {
            value = value.slice(0, -1); continue;
          }
          if (char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126 || value.length >= 4096) {
            finish(Error("Input segreto non valido.")); return;
          }
          value += char;
        }
      };
      process.stdin.on("data", onData);
    });
  } finally {
    process.stdin.setRawMode(original);
    process.stdout.write("\n");
  }
}
export function cloudflareInstructions({ runnerUrl, origin }) {
  validatePublicRunnerUrl(runnerUrl); validateFactoryOrigin(origin);
  return [
    "INSTALLAZIONE AVVIATA (non equivale a prova reboot o connessione pubblica).",
    "Cloudflare Dashboard → Networking → Tunnels → seleziona il tunnel.",
    "Seleziona Routes → Add route → Published application.",
    "Hostname pubblico: " + new URL(runnerUrl).hostname + ".",
    "Service type: HTTP. Service URL: http://runner-api:8787 (nome container interno, porta 8787).",
    "NON usare localhost:8787 dentro cloudflared: localhost punta al container cloudflared stesso.",
    "Associa il DNS tunnel al tuo dominio nel pannello Cloudflare e configura Access/identity.",
    "Assicurati che Access permetta i preflight OPTIONS per il browser cross-origin.",
    "Origin CORS del sito: " + origin + " (NON include /SoftwareFactory/).",
    "In SoftwareFactory → Settings → Runner API URL: " + runnerUrl,
    "In SoftwareFactory → Settings → Runner API key: inserisci la chiave creata localmente.",
    "Docker rootless user service + linger e restart: unless-stopped danno riavvio automatico.",
    "Verifica realmente dopo reboot, via HTTPS e con un job controllato, prima dell'uso normale.",
    "Il token Cloudflare rimane SOLO sull'host, non va inserito in SoftwareFactory o nel cloud.",
  ].join("\n");
}

/** Operator must approve the exact SHA and canary digest BEFORE provisioning.
 * For a GitHub Release archive the source manifest is read independently
 * from the approved tar.gz and every extracted file is hashed. An archive
 * checksum hosted beside its asset is NOT an independent signature.
 *
 * All injected callbacks are Node unit-test seams, never CLI options.
 */
export async function approveInstallerSource({
  root = repoRoot, ask, write = () => {},
  gitPresent = existsSync(join(root, ".git")),
  run = runChecked, verifyGit = verifyCleanPinnedMain,
  verifyArchive = verifyInstallerReleaseSource,
  readManifest = () => JSON.parse(readFileSync(join(root, ".sf-installer-source.json"), "utf8")),
} = {}) {
  if (typeof ask !== "function") throw Error("Serve conferma operatore.");
  let commit, extra = [];
  if (gitPresent) {
    commit = String(run("git", ["rev-parse", "--verify", "HEAD"], { silent: true })).trim();
    const branch = String(run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { silent: true })).trim();
    if (branch !== "main" || !/^[a-f0-9]{40}$/.test(commit))
      throw Error("Checkout Git principale non verificato.");
    await verifyGit({ commit });
  } else {
    const archive = (await ask("Percorso ASSOLUTO dell'archivio .tar.gz scaricato dalla Release: ")).trim();
    const archiveSha256 = (await ask("SHA-256 esatta verificata dalla Release: ")).trim();
    const manifest = readManifest();
    commit = manifest?.commit;
    if (!/^[a-f0-9]{40}$/.test(commit))
      throw Error("Manifest sorgente della Release assente o invalido.");
    await verifyArchive({ root, archive, archiveSha256, commit });
    extra = ["--archive=" + archive, "--archive-sha256=" + archiveSha256];
  }
  write("Sorgente da approvare, commit SHA-40: " + commit + "\n");
  if ((await ask("Digita ESATTAMENTE la SHA-40 mostrata per approvare il sorgente: ")).trim() !== commit)
    throw Error("SHA sorgente non approvata.");
  const image = (await ask("Immagine canary Docker immutabile node@sha256:<digest64>: ")).trim();
  if (!/^node@sha256:[a-f0-9]{64}$/.test(image))
    throw Error("Digest canary non valido o non approvato.");
  write("Canary rootless autorizzato su digest immutabile; non equivale a collaudo della VM.\n");
  return { commit, image, sourceArgs: ["--commit=" + commit, ...extra] };
}

/**
 * Interactive run does not accept secrets from CLI args or config from untrusted web requests.
 * run/provision/prompt are test-only seams, not HTTP inputs.
 */
export async function main(argv = process.argv.slice(2), {
  ask = async (text) => { const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(text); } finally { rl.close(); } },
  secretPrompt = hiddenPrompt, provision = provisionSignedDockerPackages,
  run = runChecked, write = msg => process.stdout.write(msg),
  configure = writePrivateHostConfig,
} = {}) {
  if (argv.length !== 0) throw Error("Non passare API key, Cloudflare token o altri argomenti nella shell.");
  assertDedicated();
  if (existsSync(envFile)) throw Error("Runner già configurato: modifica o aggiorna in sicurezza, nessuna sovrascrittura.");
  // Do not commandeer an existing rootful Docker service on a shared server.
  const existing = spawnSync("systemctl", ["is-active", "--quiet", "docker.service"], {
    stdio: "ignore", timeout: 3000,
  });
  if (existing.status === 0)
    throw Error("Docker rootful già attivo: usare una VM/account dedicato, installer rifiutato.");
  const approved = (await ask("VM/PC dedicato e vuoto, pacchetti apt firmati e modifiche systemd? Digita INSTALLA per confermare: ")).trim();
  if (approved !== "INSTALLA") throw Error("Installazione annullata senza provisioning.");
  // Authenticate the exact repository/archive bytes before apt, Docker or
  // private secret writes; #88 will recheck the same source on every gate.
  const reviewed = await approveInstallerSource({ ask, write, run });
  const origin = validateFactoryOrigin((await ask("Origin esatta GitHub Pages [https://keyserdsoze.github.io]: ")).trim() ||
    "https://keyserdsoze.github.io");
  const runnerUrl = validatePublicRunnerUrl((await ask("URL HTTPS pubblico configurabile su Cloudflare: ")).trim());
  const cloudflareToken = validateCloudflareToken((await secretPrompt("Token del Tunnel Cloudflare (input nascosto): ")).trim());
  const mode = (await ask("API key [g=generata, p=personalizzata]: ")).trim().toLowerCase();
  if (!["g", "p"].includes(mode)) throw Error("Seleziona una modalità di API key.");
  const secret = mode === "p" ? validateOperatorApiKey((await secretPrompt("API key (minimo 32 caratteri, input nascosto): ")).trim())
    : randomBytes(32).toString("hex");
  write("Verifica repository Docker firmato e installazione pacchetti (sudo richiederà autorizzazione) ...\n");
  await provision();
  // On a brand-new dedicated host, a rootful daemon installed as a package
  // must not be left listening. Do not silently stop a shared daemon.
  run("sudo", ["systemctl", "disable", "--now", "docker.socket", "docker.service"]);
  for (const [binary, args] of rebootServicePlan()) run(binary, args);
  const root = join(homedir(), ".local/share/softwarefactory-runner");
  configure({ origin, root, cloudflareToken, secret });
  // Never call the old direct "host-setup start" shortcut: it bypassed the
  // #88 digest-pinned canary, container checks and authenticated readiness.
  run(process.execPath, ["src/runner/scripts/host-install.mjs",
    "--env-file=" + envFile, ...reviewed.sourceArgs,
    "--image=" + reviewed.image, "--apply", "--confirm-install"]);
  // Cloudflare is only enabled AFTER both runner services are authenticated
  // and verified on the rootless daemon. This does not attest public Access.
  run(process.execPath, ["src/runner/scripts/host-setup.mjs",
    "tunnel", "--confirm-tunnel"]);
  write("\n" + cloudflareInstructions({ origin, runnerUrl }) + "\n");
  if (mode === "g" && (await ask("Mostrare una sola volta la API key generata sul terminale? Scrivi MOSTRA (attenzione a video/condivisione): ")).trim() === "MOSTRA")
    write("API key (non viene ripetuta): " + secret + "\n");
  return { status: "started", rebootVerified: false, cloudflareConnected: false };
}
if (process.argv[1] && process.argv[1].endsWith("/interactive-install.mjs")) {
  main().catch(error => {
    // Never log raw error objects, tokens, command environment or command output.
    process.stderr.write("Installer: " + (error instanceof Error ? error.message : "Installazione interrotta") + "\n");
    process.exitCode = 1;
  });
}
