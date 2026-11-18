import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { renderRunnerEnv, validateFactoryOrigin, validateRunnerRoot,
  writePrivateHostConfig, startVerifiedTunnel } from "../scripts/host-setup.mjs";

test("host setup accepts only exact trusted HTTPS origins and local dev", () => {
  assert.equal(validateFactoryOrigin("https://keyserdsoze.github.io"), "https://keyserdsoze.github.io");
  assert.equal(validateFactoryOrigin("http://localhost:5173"), "http://localhost:5173");
  for (const bad of [
    "https://keyserdsoze.github.io/SoftwareFactory/", "http://example.org",
    "https://user:pass@example.org", "https://example.org?key=123",
    "https://example.org/#x", "https://*.example.org", "https://example.org\nFOO=bar",
    "file:///tmp", "https://example.org:443",
  ]) assert.throws(() => validateFactoryOrigin(bad), /origin|Origin|HTTPS/);
});
test("host setup renders private runtime config with random secret, pinned rootless socket and closed network", () => {
  const key = "f".repeat(64);
  const env = renderRunnerEnv({
    origin: "https://keyserdsoze.github.io", root: "/home/softwarefactory/runner", apiKey: key,
  });
  assert.match(env, /RUNNER_DOCKER_SOCKET=\/run\/user\/1000\/docker.sock/);
  assert.match(env, /RUNNER_ALLOW_NET_DEPS=false/);
  assert.match(env, /RUNNER_ALLOWED_ORIGINS=https:\/\/keyserdsoze.github.io/);
  assert.match(env, /RUNNER_API_KEY=f{64}/);
  assert.match(env, /CLOUDFLARE_TUNNEL_TOKEN=REPLACE_ONLY_WHEN_USING_CLOUDFLARE/);
  assert.throws(() => renderRunnerEnv({ origin: "http://bad.example", root: "/home/runner", apiKey: key }));
  assert.throws(() => renderRunnerEnv({ origin: "https://example.org", root: "/home/runner", apiKey: "short" }));
});
test("host root never resolves to /, HOME or a sibling path", () => {
  assert.throws(() => validateRunnerRoot("/"));
  assert.throws(() => validateRunnerRoot(homedir()));
  assert.throws(() => validateRunnerRoot("/etc/softwarefactory"));
  assert.equal(validateRunnerRoot(join(homedir(), ".local", "share", "softwarefactory-runner")),
    join(homedir(), ".local", "share", "softwarefactory-runner"));
});
test("setup creates 0600 credentials and 0700 private data once, never overwrites", { skip: !process.getuid || process.getuid() === 0 }, () => {
  // Test runs under the ordinary GitHub Actions user, not Docker or the host setup CLI.
  const base = mkdtempSync(join(homedir(), "sf-host-setup-test-"));
  try {
    const root = join(base, "private");
    const destination = join(base, "runner.env");
    const saved = writePrivateHostConfig({
      origin: "https://keyserdsoze.github.io", root, destination, uid: process.getuid(),
      secret: "a".repeat(64),
    });
    assert.equal(saved.configPath, destination);
    assert.equal(lstatSync(destination).mode & 0o777, 0o600);
    assert.equal(lstatSync(root).mode & 0o077, 0);
    assert.equal(lstatSync(saved.data).mode & 0o077, 0);
    assert.equal(lstatSync(saved.work).mode & 0o077, 0);
    assert.match(readFileSync(destination, "utf8"), /RUNNER_API_KEY=a{64}/);
    assert.throws(() => writePrivateHostConfig({
      origin: "https://keyserdsoze.github.io", root, destination, uid: process.getuid(),
    }), /già presente/);
    assert.equal(existsSync(saved.work), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});


test("tunnel cannot begin before rootless preflight and authenticated API+worker readiness", async () => {
  const envPath = "/srv/softwarefactory/private/runner.env";
  const token = "T".repeat(120), key = "s".repeat(64);
  const baseEnv = {
    RUNNER_API_KEY: key, CLOUDFLARE_TUNNEL_TOKEN: token,
  };
  const host = { mode: "host", status: "passed",
    uid: 1000, dockerRootless: true };
  const compose = { mode: "compose", status: "passed", apiLoopbackOnly: true,
    dockerSocketInWorkerOnly: true, tunnelServiceChecked: true };
  const run = async ({ env = baseEnv, proofHost = host, proofCompose = compose,
    rootless = true, ready = true } = {}) => {
    const calls = [];
    const receipt = await startVerifiedTunnel({
      envPath, uid: 1000, euid: 1000,
      readEnv: async () => { calls.push(["env"]); return env; },
      preflightCheck: async argv => {
        calls.push(["preflight",argv[0]]);
        return argv[0] === "host" ? proofHost : proofCompose;
      },
      rootlessProbe: async ({host}) => {
        calls.push(["rootless",host]);
        return rootless;
      },
      readiness: async ({bearer}) => {
        assert.equal(bearer, key);
        calls.push(["ready"]);
        return ready;
      },
      runCompose: async (argv, options) => {
        calls.push(["compose",...argv]);
        assert.deepEqual(argv.slice(-4),
          ["up","-d","--no-deps","cloudflared"]);
        assert.ok(!argv.includes("runner-api"));
        assert.ok(!argv.includes("runner-worker"));
        assert.ok(!argv.includes("down"));
        assert.equal(options.env.DOCKER_HOST, "unix:///run/user/1000/docker.sock");
        assert.equal(options.env.CLOUDFLARE_TUNNEL_TOKEN, undefined);
        return true;
      },
    });
    return { receipt, calls };
  };
  const result = await run();
  assert.deepEqual(result.receipt, { status: "tunnel-start-requested",
    rootless: true, apiAuthenticated: true, publicAccessVerified: false });
  assert.equal(result.calls.filter(x => x[0] === "rootless").length,2);
  assert.equal(result.calls.filter(x => x[0] === "compose").length,1);
  for (const overrides of [
    { env: { ...baseEnv, CLOUDFLARE_TUNNEL_TOKEN: "short" } },
    { env: { ...baseEnv, DOCKER_HOST: "unix:///var/run/docker.sock" } },
    { env: { ...baseEnv, COMPOSE_PROFILES: "tunnel" } },
    { proofHost: { ...host, dockerRootless: false } },
    { proofCompose: { ...compose, apiLoopbackOnly: false } },
    { rootless: false }, { ready: false },
  ]) await assert.rejects(run(overrides), /Tunnel start refused/);
});

test("direct legacy host-setup start cannot bypass #88 canary and authenticated readiness", () => {
  // The legacy route used to call docker compose up without VM acceptance.
  // It is now refused, and cannot invoke either runner service.
  const path = new URL("../scripts/host-setup.mjs", import.meta.url);
  const source = readFileSync(path, "utf8");
  assert.match(source, /if \(mode === "start"\)\s+throw new Error/);
  assert.doesNotMatch(source, /"up", "-d", "--build"/);
});
