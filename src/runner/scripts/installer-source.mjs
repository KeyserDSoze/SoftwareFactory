/** Immutable release-source checks for the local, operator-driven installer.
 *
 * The archive digest is operator-provided after independently checking the
 * GitHub Release checksum. The checksum and the manifest are not signatures.
 * A Git checkout uses verifyCleanPinnedMain() instead.
 */
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync,
  readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, "../../..");
const sha = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const maxFiles = 2500, maxBytes = 60 * 1024 * 1024;
const manifestName = ".sf-installer-source.json";
const archiveMember = "softwarefactory-runner-installer/" + manifestName;
const fail = () => { throw Error("Installer Release source verification refused"); };
const safePath = rel => typeof rel === "string" && rel.length >= 1 &&
  rel.length <= 320 && !/[\x00-\x1f\x7f\\]/.test(rel) &&
  !rel.startsWith("/") && !rel.endsWith("/") &&
  rel.split("/").every(p => p && p !== "." && p !== "..") &&
  rel !== manifestName && rel !== "docker/runner/.env";
const digest = data => createHash("sha256").update(data).digest("hex");

function scan(root, { allowRuntimeEnv = false } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root) ||
      root !== path.resolve(root)) fail();
  const base = lstatSync(root);
  if (!base.isDirectory() || base.isSymbolicLink()) fail();
  const names = [];
  let total = 0;
  function traverse(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      if (rel === manifestName ||
          allowRuntimeEnv && rel === "docker/runner/.env") continue;
      if (!safePath(rel)) fail();
      const absolute = path.join(root, ...rel.split("/"));
      const meta = lstatSync(absolute);
      if (meta.isSymbolicLink() || meta.nlink !== 1 && !meta.isDirectory())
        fail();
      if (meta.isDirectory()) traverse(absolute, rel);
      else if (meta.isFile()) {
        if (meta.size > 2_000_000 || ++total > maxFiles) fail();
        names.push(rel);
      } else fail();
    }
  }
  traverse(root, "");
  return names.sort();
}

function readPinnedRegular(root, relative) {
  if (!safePath(relative)) fail();
  const filename = path.join(root, ...relative.split("/"));
  let fd;
  try {
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 ||
        before.size > 2_000_000 || before.uid !== process.getuid?.()) fail();
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.size !== bytes.length || before.size !== after.size) fail();
    return { hash: digest(bytes), size: bytes.length };
  } catch { fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function buildInstallerSourceManifest(root, commit) {
  if (!commitPattern.test(commit)) fail();
  try {
    const files = scan(root);
    if (files.length < 10 || files.length > maxFiles ||
        !files.includes("src/runner/scripts/host-install.mjs") ||
        !files.includes("docker/runner/compose.yml") ||
        !files.includes("INSTALLER.it.md") ||
        !files.includes("INSTALLER.en.md")) fail();
    let size = 0;
    const records = files.map(p => {
      const h = readPinnedRegular(root, p);
      size += h.size;
      if (size > maxBytes) fail();
      return { path: p, sha256: h.hash, size: h.size };
    });
    return { schemaVersion: 1, commit, files: records };
  } catch { fail(); }
}

function checkManifest(value, expectedCommit) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "commit,files,schemaVersion" ||
      value.schemaVersion !== 1 || value.commit !== expectedCommit ||
      !Array.isArray(value.files) || value.files.length < 10 ||
      value.files.length > maxFiles) fail();
  let previous = "", total = 0;
  for (const file of value.files) {
    if (!file || typeof file !== "object" || Array.isArray(file) ||
        Object.keys(file).sort().join(",") !== "path,sha256,size" ||
        !safePath(file.path) || previous >= file.path ||
        !sha.test(file.sha256) || !Number.isSafeInteger(file.size) ||
        file.size < 0 || file.size > 2_000_000) fail();
    total += file.size;
    if (total > maxBytes) fail();
    previous = file.path;
  }
  if (!value.files.some(x => x.path === "src/runner/scripts/host-install.mjs") ||
      !value.files.some(x => x.path === "docker/runner/compose.yml") ||
      !value.files.some(x => x.path === "INSTALLER.it.md") ||
      !value.files.some(x => x.path === "INSTALLER.en.md")) fail();
  return value;
}

const defaultManifestFromArchive = async archive => {
  const result = await execFile("tar", ["-xOzf", archive, archiveMember], {
    timeout: 15000, maxBuffer: 350_000,
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
  });
  return result.stdout;
};

/** No extract, no shell, no network, no modifications. Match the downloaded
 * immutable archive and every extracted file against the approved manifest.
 */
export async function verifyInstallerReleaseSource({
  root = defaultRoot, archive, archiveSha256, commit,
  archiveReader = defaultManifestFromArchive,
} = {}) {
  if (!commitPattern.test(commit) || !sha.test(archiveSha256) ||
      typeof archive !== "string" || !path.isAbsolute(archive) ||
      archive !== path.resolve(archive) || archive.length > 4096) fail();
  try {
    const meta = lstatSync(archive);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1 ||
        meta.size < 1000 || meta.size > maxBytes || meta.uid !== process.getuid?.()) fail();
    const bytes = readFileSync(archive);
    if (bytes.length !== meta.size || digest(bytes) !== archiveSha256) fail();
    const raw = await archiveReader(archive);
    if (typeof raw !== "string" || raw.length > 350_000) fail();
    const after = lstatSync(archive);
    if (after.dev !== meta.dev || after.ino !== meta.ino ||
        after.size !== meta.size || after.mtimeMs !== meta.mtimeMs ||
        after.ctimeMs !== meta.ctimeMs || after.isSymbolicLink()) fail();
    const parsed = checkManifest(JSON.parse(raw), commit);
    const manifestStat = lstatSync(path.join(root, manifestName));
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() ||
        manifestStat.nlink !== 1 || manifestStat.uid !== process.getuid?.()) fail();
    const actualManifest = readFileSync(path.join(root, manifestName), "utf8");
    if (actualManifest !== raw) fail();
    const paths = scan(root, { allowRuntimeEnv: true });
    if (paths.length !== parsed.files.length ||
        paths.some((p, i) => p !== parsed.files[i].path)) fail();
    for (const f of parsed.files) {
      const verified = readPinnedRegular(root, f.path);
      if (verified.size !== f.size || verified.hash !== f.sha256) fail();
    }
    return { source: "approved-release", commit, files: paths.length };
  } catch { fail(); }
}

/** Called on the CI checkout staging tree, never on host .env or downloaded
 * source. The release SHA stays out of the generated manifest until the
 * separate final archive is hashed.
 */
export function createInstallerSourceManifest(root, commit) {
  const value = buildInstallerSourceManifest(root, commit);
  writeFileSync(path.join(root, manifestName), JSON.stringify(value) + "\n",
    { flag: "wx", mode: 0o644 });
  return { commit, files: value.files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const execute = async () => {
    if (argv.length === 3 && argv[0] === "create" &&
        argv[1].startsWith("--root=") &&
        argv[2].startsWith("--commit=")) {
      const result = createInstallerSourceManifest(argv[1].slice(7), argv[2].slice(9));
      process.stdout.write("INSTALLER_SOURCE_MANIFEST_CREATED: " +
        result.commit + " (" + result.files + " files)\n");
    } else if (argv.length === 5 && argv[0] === "verify" &&
        argv[1].startsWith("--root=") &&
        argv[2].startsWith("--archive=") &&
        argv[3].startsWith("--archive-sha256=") &&
        argv[4].startsWith("--commit=")) {
      const result = await verifyInstallerReleaseSource({
        root: argv[1].slice(7), archive: argv[2].slice(10),
        archiveSha256: argv[3].slice(17), commit: argv[4].slice(9),
      });
      process.stdout.write("INSTALLER_SOURCE_VERIFIED: " +
        result.commit + " (" + result.files + " files)\n");
    } else fail();
  };
  execute().catch(() => {
    // Never show underlying paths, file names, or downstream tar output.
    console.error("INSTALLER_SOURCE_VERIFICATION_REFUSED");
    process.exitCode = 1;
  });
}
