import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
  symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createInstallerSourceManifest, verifyInstallerReleaseSource,
  buildInstallerSourceManifest,
} from "../scripts/installer-source.mjs";

const commit = "e".repeat(40);
const files = [
  "src/runner/scripts/host-install.mjs", "src/runner/scripts/interactive-install.mjs",
  "src/runner/scripts/host-setup.mjs", "docker/runner/compose.yml",
  "INSTALLER.it.md", "INSTALLER.en.md", "README.md", "AGENTS.md",
  "docs/runner.md", "src/runner/api.mjs", "src/runner/worker.mjs",
  "src/runner/package.json",
];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-installer-source-"));
  const root = path.join(dir, "softwarefactory-runner-installer");
  mkdirSync(root);
  for (const [i, file] of files.entries()) {
    const filename = path.join(root, file);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, "tracked source " + i + " with review\n", { mode: 0o644 });
  }
  const created = createInstallerSourceManifest(root, commit);
  const manifest = JSON.parse(readFileSync(path.join(root, ".sf-installer-source.json"), "utf8"));
  const archive = path.join(dir, "installer.tar.gz");
  const command = spawnSync("tar", ["--sort=name", "-czf", archive,
    "-C", dir, "softwarefactory-runner-installer"], { encoding: "utf8" });
  assert.equal(command.status, 0, command.stderr);
  return { dir, root, archive, archiveSha256: sha256(readFileSync(archive)),
    commit, manifest, created };
}
async function withFixture(fn) {
  const f = fixture();
  try { await fn(f); } finally { rmSync(f.dir, { recursive: true, force: true }); }
}
const linuxOnly = { skip: process.platform !== "linux" };

test("release manifest binds source SHA, sorted exact paths and all tracked file bytes", linuxOnly, async () =>
  withFixture(async f => {
    assert.deepEqual(f.created, { commit, files: files.length });
    assert.equal(f.manifest.schemaVersion, 1);
    assert.equal(f.manifest.commit, commit);
    assert.deepEqual(f.manifest.files.map(x => x.path),
      [...files].sort());
    const verified = await verifyInstallerReleaseSource(f);
    assert.deepEqual(verified, { source: "approved-release", commit, files: files.length });
    writeFileSync(path.join(f.root, "docker/runner/.env"),
      "RUNNER_API_KEY=" + "a".repeat(64) + "\n", { mode: 0o600 });
    // A private runtime config is not source code and is separately checked
    // by the host preflight. Creating it does not invalidate signed release files.
    assert.equal((await verifyInstallerReleaseSource(f)).files, files.length);
  }));

test("release source rejects swapped README, executable, manifest or added file", linuxOnly, async () =>
  withFixture(async f => {
    for (const file of ["README.md", "src/runner/scripts/host-install.mjs",
      "docker/runner/compose.yml", ".sf-installer-source.json"]) {
      const filename = path.join(f.root, file);
      const original = readFileSync(filename);
      writeFileSync(filename, Buffer.concat([original, Buffer.from("\nadded\n")]));
      await assert.rejects(verifyInstallerReleaseSource(f),
        /Installer Release source verification refused/);
      writeFileSync(filename, original);
    }
    writeFileSync(path.join(f.root, "src/runner/scripts/evil.mjs"), "bad\n");
    await assert.rejects(verifyInstallerReleaseSource(f), /refused/);
  }));

test("release source rejects unapproved archive checksum, commit, path and manifest", linuxOnly, async () =>
  withFixture(async f => {
    for (const options of [
      { archiveSha256: "f".repeat(64) },
      { commit: "d".repeat(40) },
      { archiveSha256: "x".repeat(64) },
      { archive: "relative.tar.gz" },
      { archive: f.archive.replace(/installer/, "../installer") },
      { archiveSha256: "" },
    ]) await assert.rejects(verifyInstallerReleaseSource({ ...f, ...options }),
      /refused/);
    const content = readFileSync(f.archive);
    writeFileSync(f.archive, Buffer.concat([content, Buffer.from("injected")]));
    await assert.rejects(verifyInstallerReleaseSource(f), /refused/);
  }));

test("release source rejects symlinks, missing files and attacker-controlled directories", linuxOnly, async () =>
  withFixture(async f => {
    const p = path.join(f.root, "src/runner/scripts/host-install.mjs");
    const original = readFileSync(p);
    rmSync(p);
    symlinkSync(path.join(f.root, "README.md"), p);
    await assert.rejects(verifyInstallerReleaseSource(f), /refused/);
    rmSync(p);
    writeFileSync(p, original);
    const docs = path.join(f.root, "docs");
    const hold = path.join(f.dir, "backup-docs");
    renameSync(docs, hold);
    symlinkSync(hold, docs);
    await assert.rejects(verifyInstallerReleaseSource(f), /refused/);
  }));

test("manifest generation forbids symlinks, untracked runtime code and invalid SHA", linuxOnly, () =>
  withFixture(async f => {
    assert.throws(() => buildInstallerSourceManifest(f.root, "invalid"), /refused/);
    assert.throws(() => createInstallerSourceManifest(f.root, commit), /EEXIST/);
    const link = path.join(f.root, "src/runner/scripts/rogue.mjs");
    symlinkSync(path.join(f.root, "README.md"), link);
    assert.throws(() => buildInstallerSourceManifest(f.root, commit), /refused/);
  }));
