import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseLinuxDistro, validatePublicRunnerUrl, dockerRepoSource,
  hasVerifiedDockerFingerprint, rebootServicePlan,
  cloudflareInstructions, provisionSignedDockerPackages,
} from "../scripts/interactive-install.mjs";
import { renderRunnerEnv, validateCloudflareToken,
  validateOperatorApiKey } from "../scripts/host-setup.mjs";

test("only supported distributions/architectures yield a signed-by Docker apt source", () => {
  assert.deepEqual(parseLinuxDistro('ID=ubuntu\nVERSION_CODENAME="noble"\n'), { id: "ubuntu", codename: "noble" });
  assert.deepEqual(parseLinuxDistro('ID=debian\nVERSION_CODENAME=bookworm\n'), { id: "debian", codename: "bookworm" });
  for (const invalid of ['ID=arch\nVERSION_CODENAME=rolling\n',
    'ID=ubuntu\nVERSION_CODENAME="../../bad"\n', 'ID=ubuntu\n']) {
    assert.throws(() => parseLinuxDistro(invalid), /supportato/);
  }
  assert.match(dockerRepoSource({ id: "debian", codename: "bookworm" }, "amd64"),
    /signed-by=\/etc\/apt\/keyrings\/softwarefactory-docker.asc/);
  assert.throws(() => dockerRepoSource({ id: "ubuntu", codename: "noble" }, "i386"));
});
test("Docker repository signing key requires exact expected pinned fingerprint", () => {
  const verified = "pub:-:4096:1:ABC\nfpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:\n";
  assert.equal(hasVerifiedDockerFingerprint(verified), true);
  assert.equal(hasVerifiedDockerFingerprint(verified.replace("9DC8", "1234")), false);
  assert.equal(hasVerifiedDockerFingerprint("unrelated"), false);
});
test("apt provisioning never runs arbitrary shell, URLs via bash or unverified key", async () => {
  const calls = []; const fingerprint = "fpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:\n";
  const exec = (program, argv) => {
    calls.push([program, [...argv]]);
    return program === "dpkg" ? "amd64\n" : program === "gpg" ? fingerprint : "";
  };
  await provisionSignedDockerPackages({
    osRelease: () => 'ID=debian\nVERSION_CODENAME=bookworm\n',
    run: exec, fetchKey: async () => Buffer.from("fixture-key"),
    keyLocation: "/tmp/fixture-nonexistent-docker-key", sourceLocation: "/tmp/fixture-nonexistent-docker-list",
  });
  assert.ok(calls.some(([cmd, argv]) => cmd === "sudo" && argv.includes("docker-ce-rootless-extras")));
  assert.ok(calls.some(([cmd, argv]) => cmd === "sudo" && argv.includes("docker-compose-plugin")));
  assert.ok(!calls.some(([cmd, args]) => cmd === "sh" || cmd === "bash" || args.includes("-c")));
  const badCalls = [];
  await assert.rejects(provisionSignedDockerPackages({
    osRelease: () => 'ID=ubuntu\nVERSION_CODENAME=noble\n',
    run: (cmd, args) => { badCalls.push([cmd, args]);
      return cmd === "dpkg" ? "amd64\n" : cmd === "gpg" ? "fpr:::::::::BAD:\n" : ""; },
    fetchKey: async () => Buffer.from("wrong-key"),
    keyLocation: "/tmp/fixture-nonexistent-docker-key", sourceLocation: "/tmp/fixture-nonexistent-docker-list",
  }), /fingerprint/);
  assert.ok(!badCalls.some(([cmd, args]) => cmd === "sudo" && args.includes("docker-ce")));
});
test("token and operator-defined key are never inserted into CLI arguments", () => {
  const token = "A".repeat(128);
  assert.equal(validateCloudflareToken(token), token);
  assert.equal(validateOperatorApiKey("my-strong-key-" + "k".repeat(35)),
    "my-strong-key-" + "k".repeat(35));
  for (const invalid of ["", "abc", "x\ny", "REPLACE_" + "a".repeat(128)]) {
    assert.throws(() => validateCloudflareToken(invalid));
  }
  assert.throws(() => validateOperatorApiKey("short"));
  assert.throws(() => validateOperatorApiKey("a ".repeat(30)));
  const env = renderRunnerEnv({
    origin: "https://keyserdsoze.github.io", root: "/home/test/private",
    apiKey: "my-strong-key-" + "k".repeat(35), cloudflareToken: token,
  });
  assert.match(env, /CLOUDFLARE_TUNNEL_TOKEN=A{128}/);
  assert.match(env, /RUNNER_API_KEY=my-strong-key-/);
});
test("startup has linger + rootless docker user service; Cloudflare route is private container port 8787", () => {
  assert.deepEqual(rebootServicePlan().map(([cmd, args]) => [cmd, args.slice(0, 2)]), [
    ["sudo", ["loginctl", "enable-linger"]],
    ["dockerd-rootless-setuptool.sh", ["install"]],
    ["systemctl", ["--user", "enable"]],
  ]);
  const guide = cloudflareInstructions({
    origin: "https://keyserdsoze.github.io", runnerUrl: "https://runner.example.com",
  });
  assert.match(guide, /http:\/\/runner-api:8787/);
  assert.match(guide, /https:\/\/runner.example.com/);
  assert.match(guide, /localhost:8787.*container/);
  assert.doesNotMatch(guide, /CLOUDFLARE_TUNNEL_TOKEN=/);
  assert.equal(validatePublicRunnerUrl("https://runner.example.com"), "https://runner.example.com");
  for (const bad of ["http://runner.example.com", "https://runner.example.com/api", "https://user:pass@runner.example.com"]) {
    assert.throws(() => validatePublicRunnerUrl(bad));
  }
});
