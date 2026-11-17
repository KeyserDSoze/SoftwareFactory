/**
 * Local, operator-executed Linux bootstrap for the existing rootless runner.
 * This is NOT an SSH installer or a remotely invoked shell from GitHub Pages.
 * Requires a dedicated uid 1000 with Docker rootless installed by the operator.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
export function renderRunnerEnv({ origin, root, apiKey }) {
  validateFactoryOrigin(origin);
  if (!/^([a-f0-9]{64})$/.test(apiKey))
    throw new Error("API key non valida: richiede 32 byte casuali.");
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
    "CLOUDFLARE_TUNNEL_TOKEN=",
    "",
  ].join("\n");
}
function assertPrivateDir(directory, uid) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0)
    throw new Error("Directory host non privata (owner/permessi/link): " + directory);
}
export function writePrivateHostConfig({ origin, root, destination = envFile, uid = process.getuid?.(),
  secret = randomBytes(32).toString("hex") }) {
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
  const text = renderRunnerEnv({ origin, root: base, apiKey: secret });
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
  const r = spawnSync(program, args, { cwd: repoRoot, stdio: "inherit", timeout: 180000 });
  if (r.error || r.status !== 0) throw new Error("Preflight/installazione fallita: " + program + " (codice " + (r.status ?? "n/d") + ").");
}
export function main(argv = process.argv.slice(2)) {
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
  if (mode === "start" && flags.length === 0) {
    // Preflight requires a private .env (mode 0600) and real rootless Docker.
    runChecked(process.execPath, ["src/runner/preflight.mjs", "host", "--env-file=docker/runner/.env"]);
    runChecked(process.execPath, ["src/runner/preflight.mjs", "compose", "--env-file=docker/runner/.env"]);
    runChecked("docker", ["compose", "--env-file", "docker/runner/.env",
      "-f", "docker/runner/compose.yml", "up", "-d", "--build"]);
    process.stdout.write("Servizi avviati; controllare /healthz e le readiness autenticate. Il tunnel pubblico richiede una configurazione separata.\n");
    return;
  }
  throw new Error("Usage: host-setup.mjs setup --origin=HTTPS_ORIGIN [--root=PATH] | start");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write("Setup runner: " + (error instanceof Error ? error.message : "errore") + "\n");
    process.exitCode = 1;
  }
}
