/**
 * Local, operator-executed Linux bootstrap for the existing rootless runner.
 * This is NOT an SSH installer or a remotely invoked shell from GitHub Pages.
 * Requires a dedicated uid 1000 with Docker rootless installed by the operator.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPrivateEnv, selectEndpointBearer, main as preflight } from "../preflight.mjs";
import { probeRootlessDocker } from "../docker-probe.mjs";
import { probeInstalledRunner } from "./host-install.mjs";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const envFile = join(repoRoot, "docker/runner/.env");

export function validateFactoryOrigin(input) {
  if (typeof input !== "string" || input.length > 240 || /[\r\n\s$#"'\\]/.test(input))
    throw new Error("Specificare una origin HTTPS valida (nessuna path/query/credenziale).");
  let u;
  try { u = new URL(input); } catch { throw new Error("Origin non valida."); }
  const local = ["localhost", "127.0.0.1"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local)) ||
      u.origin !== input || u.username || u.password || u.search || u.hash ||
      !/^[a-z0-9.\-]+$/i.test(u.hostname))
    throw new Error("Usare soltanto l'origin HTTPS di GitHub Pages, oppure localhost per sviluppo.");
  return u.origin;
}
export function validateRunnerRoot(input, home = homedir()) {
  const base = resolve(home);
  if (typeof input !== "string" || !isAbsolute(input))
    throw new Error("Directory dati assoluta obbligatoria.");
  const root = resolve(input);
  if (root === "/" || root === base || !root.startsWith(base + "/"))
    throw new Error("Usare una sottodirectory privata della HOME dell'utente dedicato.");
  return root;
}
export function validateOperatorApiKey(apiKey) {
  if (typeof apiKey !== "string" || !/^[A-Za-z0-9_+=.\-]{32,128}$/.test(apiKey) || apiKey.startsWith("REPLACE_"))
    throw new Error("API key runner: almeno 32 caratteri sicuri, senza spazi o shell.");
  return apiKey;
}
export function validateCloudflareToken(token) {
  if (typeof token !== "string" || token.length < 64 || token.length > 4096 ||
      !/^[A-Za-z0-9_.=+\/-]+$/.test(token) || token.startsWith("REPLACE_"))
    throw new Error("Token Cloudflare Tunnel non valido o assente.");
  return token;
}
export function renderRunnerEnv({ origin, root, apiKey, cloudflareToken = null }) {
  validateFactoryOrigin(origin);
  validateOperatorApiKey(apiKey);
  if (cloudflareToken !== null) validateCloudflareToken(cloudflareToken);
  if (!isAbsolute(root) || /[\r\n=]/.test(root))
    throw new Error("Directory host non valida.");
  return [
    "# Generated locally by host-setup.mjs. NEVER commit or publish.",
    "RUNNER_API_KEY=" + apiKey,
    "RUNNER_ALLOWED_ORIGINS=" + origin,
    "RUNNER_DATA_DIR=" + join(root, "runner-data"),
    "RUNNER_HOST_WORK_DIR=" + join(root, "workspaces"),
    "RUNNER_DOCKER_SOCKET=/run/user/1000/docker.sock",
    "RUNNER_ALLOW_NET_DEPS=false",
    "RUNNER_MAX_ACCEPTED_PER_MINUTE=5",
    "CLOUDFLARE_TUNNEL_TOKEN=" + (cloudflareToken ?? "REPLACE_ONLY_WHEN_USING_CLOUDFLARE"),
    "",
  ].join("\n");
}
function assertPrivateDir(directory, uid) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0)
    throw new Error("Directory host non privata (owner/permessi/link): " + directory);
}
export function writePrivateHostConfig({ origin, root, destination = envFile, uid = process.getuid?.(),
  secret = randomBytes(32).toString("hex"), cloudflareToken = null }) {
  if (!Number.isInteger(uid) || uid < 1) throw new Error("Utente host non valido.");
  const home = homedir();
  const base = validateRunnerRoot(root, home);
  validateFactoryOrigin(origin);
  if (existsSync(destination)) throw new Error("File .env già presente: nessuna modifica; ruotare i segreti esplicitamente.");
  // The parent ~/.local/share is operator-owned; do not follow symlinks inside the runner root.
  mkdirSync(base, { recursive: true, mode: 0o700 });
  assertPrivateDir(base, uid);
  const data = join(base, "runner-data"), work = join(base, "workspaces");
  for (const directory of [data, work]) {
    mkdirSync(directory, { mode: 0o700 });
    assertPrivateDir(directory, uid);
  }
  const text = renderRunnerEnv({ origin, root: base, apiKey: secret, cloudflareToken });
  let fd;
  try {
    fd = openSync(destination, "wx", 0o600);
    writeSync(fd, text);
    closeSync(fd); fd = undefined;
  } catch (error) {
    if (fd !== undefined) { closeSync(fd); unlinkSync(destination); }
    throw error;
  }
  return { configPath: destination, data, work };
}
function assertDedicatedHost() {
  if (process.platform !== "linux" || process.getuid?.() !== 1000 || process.geteuid?.() !== 1000)
    throw new Error("Il bootstrap richiede Linux e un account dedicato uid 1000, non root.");
}
function runChecked(program, args) {
  const r = spawnSync(program, args, { cwd: repoRoot, stdio: "inherit", timeout: 180000,
    env: { ...process.env, DOCKER_HOST: "unix:///run/user/1000/docker.sock" } });
  if (r.error || r.status !== 0) throw new Error("Preflight/installazione fallita: " + program + " (codice " + (r.status ?? "n/d") + ").");
}

/** Tunnel-only operator confirmation after an actual rootless API+worker
 * install. The private env is loaded via O_NOFOLLOW and kept only in memory.
 * Callbacks are trusted Node unit-test seams, never HTTP or CLI overrides.
 */
export async function startVerifiedTunnel({
  envPath = envFile, uid = process.getuid?.(), euid = process.geteuid?.(),
  readEnv = readPrivateEnv, preflightCheck = argv => preflight(argv, { write: () => {} }),
  rootlessProbe = probeRootlessDocker, readiness = probeInstalledRunner,
  runCompose = (argv, options) => {
    const r = spawnSync("docker", argv, {
      ...options, cwd: repoRoot, encoding: "utf8",
    });
    if (r.error || r.status !== 0) throw Error("Tunnel Compose failed");
    return true;
  },
} = {}) {
  if (process.platform !== "linux" || uid !== 1000 || euid !== 1000 ||
      !isAbsolute(envPath) || resolve(envPath) !== envPath) throw Error("Tunnel denied");
  try {
    const env = await readEnv(envPath);
    const token = validateCloudflareToken(env.CLOUDFLARE_TUNNEL_TOKEN);
    if (!token) throw Error("Tunnel denied");
    if (Object.keys(env).some(key => /^(?:COMPOSE_[A-Z0-9_]+|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|NODE_OPTIONS|NODE_PATH)$/.test(key)))
      throw Error("Tunnel denied");
    const [host, compose] = await Promise.all([
      preflightCheck(["host", "--env-file=" + envPath]),
      preflightCheck(["compose", "--env-file=" + envPath]),
    ]);
    if (host?.mode !== "host" || host.status !== "passed" ||
        host.dockerRootless !== true || host.uid !== 1000 ||
        compose?.mode !== "compose" || compose.status !== "passed" ||
        compose.apiLoopbackOnly !== true ||
        compose.dockerSocketInWorkerOnly !== true ||
        compose.tunnelServiceChecked !== true) throw Error("Tunnel denied");
    if (await rootlessProbe({ host: "unix:///run/user/1000/docker.sock" }) !== true)
      throw Error("Tunnel denied");
    const bearer = selectEndpointBearer(env, { authMode: "inline", privateEnv: true });
    if (await readiness({ bearer }) !== true) throw Error("Tunnel denied");
    // A changed token/credential may alter the configured service or Access
    // binding; do not act on it between the two private FD reads.
    const after = await readEnv(envPath);
    const canonical = object => JSON.stringify(
      Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
    if (canonical(env) !== canonical(after)) throw Error("Tunnel denied");
    if (await rootlessProbe({ host: "unix:///run/user/1000/docker.sock" }) !== true)
      throw Error("Tunnel denied");
    await runCompose(["compose", "--project-name", "sf-runner",
      "--env-file", envPath, "-f", join(repoRoot, "docker/runner/compose.yml"),
      "--profile", "tunnel", "up", "-d", "--no-deps", "cloudflared"], {
      timeout: 120000, maxBuffer: 8192,
      env: { PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: process.env.HOME || "/tmp",
        DOCKER_HOST: "unix:///run/user/1000/docker.sock" },
    });
    return { status: "tunnel-start-requested", rootless: true,
      apiAuthenticated: true, publicAccessVerified: false };
  } catch {
    throw Error("Tunnel start refused; operator must review rootless host and Access.");
  }
}

export async function main(argv = process.argv.slice(2)) {
  assertDedicatedHost();
  const [mode, ...flags] = argv;
  if (mode === "setup" && flags.length > 0 && flags.every(v => /^--(?:origin|root)=.+$/.test(v))) {
    const opts = Object.fromEntries(flags.map(v => {
      const split = v.indexOf("="); return [v.slice(2, split), v.slice(split + 1)];
    }));
    if (!opts.origin || flags.length > 2 || Object.keys(opts).length !== flags.length)
      throw new Error("Usage: host-setup.mjs setup --origin=https://tuo-github-pages-origin [--root=HOME/subdir]");
    const root = opts.root ?? join(homedir(), ".local/share/softwarefactory-runner");
    const result = writePrivateHostConfig({ origin: opts.origin, root });
    process.stdout.write("Configurazione host privata creata in " + result.configPath +
      ". Credenziale NON mostrata. Eseguire node src/runner/scripts/host-setup.mjs start dopo i prerequisiti Docker rootless.\n");
    return;
  }
  if (mode === "start")
    throw new Error("Avvio diretto disabilitato: usare host-install.mjs con canary rootless approvato.");
  if (mode === "tunnel" && flags.length === 1 && flags[0] === "--confirm-tunnel") {
    // A tunnel must never start before the installer has verified both
    // runner services and their authenticated rootless readiness. This route
    // cannot start the API or worker or run an arbitrary command.
    await startVerifiedTunnel({ envPath: envFile });
    process.stdout.write("Cloudflared richiesto dopo verifica API/worker; verificare Access, DNS e CORS da browser.\n");
    return;
  }
  throw new Error("Usage: host-setup.mjs setup --origin=HTTPS_ORIGIN [--root=PATH] | tunnel --confirm-tunnel");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // No error objects, Docker output or credential-bearing .env in logs.
    process.stderr.write("Setup runner: operazione rifiutata; ispezionare il server Linux dedicato.\n");
    process.exitCode = 1;
  });
}
