import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, chmod, link, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inspectComposeConfig, inspectHost, probeEndpoint, readPrivateEnv, validateHostEnvironment,
  isPrivateEnvFile, isStablePrivateEnvSnapshot,
} from "../preflight.mjs";

const secret = "s".repeat(48);
const apiEnv = { RUNNER_API_KEY: secret,
  RUNNER_ALLOWED_ORIGINS: "https://factory.example.com",
  RUNNER_DATA_DIR: "/srv/softwarefactory/runner-data",
  RUNNER_HOST_WORK_DIR: "/srv/softwarefactory/workspaces",
  RUNNER_DOCKER_SOCKET: "/run/user/1000/docker.sock",
};
function service(extra = {}) {
  return { user: "1000:1000", read_only: true,
    security_opt: ["no-new-privileges:true"], cap_drop: ["ALL"],
    ...extra };
}
function composeConfig() {
  return { services: {
    "runner-api": service({
      volumes: [{ type: "bind", source: apiEnv.RUNNER_DATA_DIR, target: "/data" }],
      ports: [{ host_ip: "127.0.0.1", target: 8787, published: "8787", protocol: "tcp" }],
      environment: { RUNNER_PORT: "8787", RUNNER_API_KEY: secret },
    }),
    "runner-worker": service({
      volumes: [
        { type: "bind", source: apiEnv.RUNNER_DATA_DIR, target: "/data" },
        { type: "bind", source: apiEnv.RUNNER_HOST_WORK_DIR, target: apiEnv.RUNNER_HOST_WORK_DIR },
        { type: "bind", source: apiEnv.RUNNER_DOCKER_SOCKET, target: "/run/docker.sock" },
      ],
      environment: { DOCKER_HOST: "unix:///run/docker.sock",
        RUNNER_HOST_WORK_DIR: apiEnv.RUNNER_HOST_WORK_DIR },
    }),
    cloudflared: {
      cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
      profiles: ["tunnel"], command: "tunnel run --token not-a-real-token",
    },
  } };
}
test("resolved Compose enforces isolated worker socket and loopback-only API with sanitized output", () => {
  const config = composeConfig();
  const result = inspectComposeConfig(config);
  assert.deepEqual(result, { mode: "compose", status: "passed",
    apiLoopbackOnly: true, dockerSocketInWorkerOnly: true, tunnelServiceChecked: true });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  const noTunnel = composeConfig();
  delete noTunnel.services.cloudflared;
  assert.equal(inspectComposeConfig(noTunnel).tunnelServiceChecked, false);
});

test("Compose preflight rejects insecure port, privileges, mounts, socket, network and worker identity", () => {
  const changes = [
    c => { c.services["runner-api"].ports[0].host_ip = "0.0.0.0"; },
    c => { c.services["runner-api"].ports[0].published = "8788"; },
    c => { c.services["runner-api"].volumes.push({ type: "bind",
      source: apiEnv.RUNNER_DOCKER_SOCKET, target: "/var/run/docker.sock" }); },
    c => { c.services["runner-api"].environment.DOCKER_HOST = "unix:///run/docker.sock"; },
    c => { c.services["runner-api"].privileged = true; },
    c => { c.services["runner-api"].read_only = false; },
    c => { c.services["runner-api"].user = "0:0"; },
    c => { c.services["runner-api"].security_opt = []; },
    c => { c.services["runner-worker"].network_mode = "host"; },
    c => { c.services["runner-worker"].ports = [8787]; },
    c => { c.services["runner-worker"].volumes[2].source = "/var/run/docker.sock"; },
    c => { c.services["runner-worker"].volumes[2].target = "/var/run/docker.sock"; },
    c => { c.services["runner-worker"].volumes[1].source = "/etc"; },
    c => { c.services["runner-worker"].environment.DOCKER_HOST = "tcp://docker:2375"; },
    c => { c.services.cloudflared.ports = [443]; },
    c => { c.services.cloudflared.privileged = true; },
  ];
  for (const mutate of changes) {
    const config = composeConfig();
    mutate(config);
    assert.throws(() => inspectComposeConfig(config), Error);
  }
  const leak = composeConfig();
  leak.services["runner-api"].privileged = true;
  assert.throws(() => inspectComposeConfig(leak), error => {
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test("rootless host preflight checks socket, private directories and daemon SecurityOptions", async () => {
  const calls = [];
  const stat = async name => {
    calls.push("stat:" + name);
    const socket = name === apiEnv.RUNNER_DOCKER_SOCKET;
    return { uid: 1000, mode: socket ? 0o140660 : 0o040700,
      isDirectory: () => !socket, isSocket: () => socket, isSymbolicLink: () => false };
  };
  const runDocker = async args => {
    calls.push(args);
    return JSON.stringify(["name=seccomp,profile=builtin", "name=rootless"]);
  };
  assert.deepEqual(await inspectHost({ env: apiEnv, stat, uid: 1000, runDocker }), {
    mode: "host", status: "passed", uid: 1000,
    directoriesPrivate: true, socketPrivate: true, dockerRootless: true,
  });
  assert.ok(calls.some(value => Array.isArray(value) &&
    value.includes("unix:///run/user/1000/docker.sock") &&
    value.includes("info")));
  for (const [name, override, uid] of [
    ["rootless privileges", apiEnv, 0],
    ["rootful path", { ...apiEnv, RUNNER_DOCKER_SOCKET: "/var/run/docker.sock" }, 1000],
    ["placeholder secret", { ...apiEnv, RUNNER_API_KEY: "REPLACE_ME" }, 1000],
  ]) await assert.rejects(inspectHost({ env: override, stat, uid, runDocker }), Error, name);
  await assert.rejects(inspectHost({ env: apiEnv, stat, uid: 1000,
    runDocker: async () => JSON.stringify(["name=seccomp"] ) }), /rootless/);
  await assert.rejects(inspectHost({ env: apiEnv, stat: async p => ({
    ...await stat(p), mode: 0o040777,
  }), uid: 1000, runDocker }), /unsafe/);
  await assert.rejects(inspectHost({ env: apiEnv, stat: async p => ({
    ...await stat(p), isSymbolicLink: () => true,
  }), uid: 1000, runDocker }), /unsafe/);
});

test("HTTPS endpoint probe sends no writes, never follows redirects and verifies auth plus CORS", async () => {
  const requests = [];
  const baseUrl = "https://runner.example.org";
  const origin = "https://factory.example.org";
  const fakeFetch = async (url, opts) => {
    requests.push({ url, opts });
    const route = new URL(url).pathname;
    if (route === "/healthz") return new Response("{}", { status: 200 });
    if (route === "/v1/capabilities" && !opts.headers.Authorization)
      return new Response('{"error":"unauthorized"}', { status: 401 });
    if (route === "/v1/capabilities" && opts.headers.Authorization)
      return new Response(JSON.stringify({ protocol: 1, networkDefault: "none",
        steps: ["dotnet-build", "dotnet-test", "web-build"] }), { status: 200 });
    if (route === "/v1/jobs" && opts.method === "OPTIONS")
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
      } });
    throw Error("Unexpected endpoint request");
  };
  const result = await probeEndpoint({ baseUrl, origin, apiKey: secret, fetchImpl: fakeFetch });
  assert.equal(result.corsPreflightPassed, true);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(x => x.opts.method !== "POST" && x.opts.redirect === "manual"));
  assert.deepEqual(requests.map(x => x.opts.method), ["GET", "GET", "GET", "OPTIONS"]);
  assert.equal(requests.filter(x => x.opts.headers.Authorization).length, 1);
  assert.ok(requests.every(x => new URL(x.url).origin === baseUrl));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  await assert.rejects(probeEndpoint({ baseUrl: "http://runner.example.org", origin,
    apiKey: secret, fetchImpl: fakeFetch }), /HTTPS/);
  await assert.rejects(probeEndpoint({ baseUrl: baseUrl + "/wrong", origin,
    apiKey: secret, fetchImpl: fakeFetch }), /HTTPS/);
  await assert.rejects(probeEndpoint({ baseUrl: baseUrl + "@evil.example.org", origin,
    apiKey: secret, fetchImpl: fakeFetch }), /HTTPS/);
  await assert.rejects(probeEndpoint({ baseUrl, origin, apiKey: secret,
    fetchImpl: async () => new Response(null, { status: 302, headers: {
      Location: "https://attacker.example.com/",
    } }) }), /redirect/i);
  await assert.rejects(probeEndpoint({ baseUrl, origin, apiKey: secret,
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname === "/healthz") return new Response(null, { status: 200 });
      return new Response(null, { status: 200 });
    } }), /credentials/);
  await assert.rejects(probeEndpoint({ baseUrl, origin, apiKey: secret,
    fetchImpl: async (url, options) => {
      if (options.method === "OPTIONS") return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
      } });
      return fakeFetch(url, options);
    } }), /CORS/);
});

test("private env reading rejects symlinks, world-readable secrets and duplicate keys", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-preflight-private-"));
  const file = path.join(dir, "runner.env");
  try {
    await writeFile(file, [
      "# private runner",
      "RUNNER_API_KEY=" + secret,
      "RUNNER_ALLOWED_ORIGINS=https://factory.example.org",
      "RUNNER_DOCKER_SOCKET=/run/user/1000/docker.sock",
      "RUNNER_DATA_DIR=/srv/softwarefactory/data",
      "RUNNER_HOST_WORK_DIR=/srv/softwarefactory/workspaces",
    ].join("\n"), { mode: 0o600 });
    assert.equal((await readPrivateEnv(file)).RUNNER_API_KEY, secret);
    await chmod(file, 0o644);
    await assert.rejects(readPrivateEnv(file), /0600/);
    await chmod(file, 0o600);
    await symlink(file, path.join(dir, "linked"));
    await assert.rejects(readPrivateEnv(path.join(dir, "linked")), /symlink/);
    await writeFile(file, "RUNNER_API_KEY=" + secret + "\nRUNNER_API_KEY=" + secret);
    await assert.rejects(readPrivateEnv(file), /unsupported syntax/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("optional directory-mounted private registry is API-only, read-only and required by file mode", () => {
  const secure = composeConfig();
  secure.services["runner-api"].volumes.push({
    type: "bind", source: "/srv/softwarefactory/repair-operators",
    target: "/run/secrets/runner-operators", read_only: true,
  });
  secure.services["runner-api"].environment.RUNNER_REPAIR_OPERATORS_FILE =
    "/run/secrets/runner-operators/operators.json";
  secure.services["runner-api"].environment.RUNNER_REPAIR_OPERATORS_JSON = "";
  assert.equal(inspectComposeConfig(secure).status, "passed");

  const mutations = [
    c => { c.services["runner-api"].volumes[1].read_only = false; },
    c => { c.services["runner-api"].volumes[1].source = apiEnv.RUNNER_DATA_DIR; },
    c => { c.services["runner-api"].volumes[1].source = "/etc"; },
    c => { c.services["runner-api"].volumes[1].target = "/run/secrets/something"; },
    c => { c.services["runner-api"].environment.RUNNER_REPAIR_OPERATORS_FILE =
      "/data/operators.json"; },
    c => { c.services["runner-api"].environment.RUNNER_REPAIR_OPERATORS_JSON =
      '[{"id":"unacceptable","key":"fake","roles":["approve"]}]'; },
    c => { c.services["runner-api"].volumes.pop(); },
    c => { c.services["runner-worker"].volumes.push(
      structuredClone(c.services["runner-api"].volumes[1])); },
  ];
  for (const mutate of mutations) {
    const c = structuredClone(secure);
    mutate(c);
    assert.throws(() => inspectComposeConfig(c),
      /runner-api|runner-worker|unsafe|mount/i);
  }
});


test("preflight env loader pins O_NOFOLLOW descriptor, strict owner/mode/link and bounded size", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-preflight-env-fd-"));
  const file = path.join(dir, "runner.env"), hardlink = path.join(dir, "hardlink");
  try {
    await writeFile(file, "RUNNER_API_KEY=" + secret + "\n", { mode: 0o600 });
    const before = await (await import("node:fs/promises")).stat(file);
    assert.equal(isPrivateEnvFile(before), true);
    assert.equal(isStablePrivateEnvSnapshot(before, before), true);
    const fake = { ...before, isFile: () => true };
    for (const mutation of [
      { ino: before.ino + 1 }, { dev: before.dev + 1 },
      { uid: before.uid + 1 }, { gid: before.gid + 1 },
      { mode: before.mode | 0o020 }, { nlink: 2 },
      { size: before.size + 1 }, { ctimeMs: before.ctimeMs + 1 },
      { mtimeMs: before.mtimeMs + 1 },
    ]) {
      assert.equal(isStablePrivateEnvSnapshot(before, { ...fake, ...mutation }), false);
    }
    assert.equal(isPrivateEnvFile({ ...fake, size: 0 }), false);
    assert.equal(isPrivateEnvFile({ ...fake, size: 32_769 }), false);
    assert.equal(isPrivateEnvFile({ ...fake, uid: before.uid + 1 }), false);
    assert.equal(isPrivateEnvFile({ ...fake, mode: before.mode | 0o040 }), false);
    assert.equal((await readPrivateEnv(file)).RUNNER_API_KEY, secret);
    await link(file, hardlink);
    await assert.rejects(readPrivateEnv(file), /stable private inode/);
    await rm(hardlink);
    await writeFile(file, "x".repeat(32_769));
    await assert.rejects(readPrivateEnv(file), /stable private inode/);
    await writeFile(file, "");
    await assert.rejects(readPrivateEnv(file), /stable private inode/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("preflight env loading refuses modifications during read, including same-size credential replacement", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-preflight-env-mutations-"));
  const file = path.join(dir, "runner.env"), alias = path.join(dir, "alias");
  const original = "RUNNER_API_KEY=" + "a".repeat(48) + "\n";
  const replacement = "RUNNER_API_KEY=" + "b".repeat(48) + "\n";
  try {
    for (const fault of ["rewrite", "truncate", "append", "chmod", "link", "early-eof"]) {
      await rm(alias, { force: true });
      await rm(file, { force: true });
      await writeFile(file, original, { mode: 0o600 });
      let injected = false;
      const openFile = async (name, flags) => {
        const descriptor = await open(name, flags);
        let stats = 0;
        return {
          stat: async () => {
            const snapshot = await descriptor.stat();
            if (++stats === 2 && fault === "rewrite") {
              // Filesystems may coarsen timestamp resolution: simulate the
              // observed ctime change to make same-length race deterministic.
              return { ...snapshot, isFile: () => true,
                ctimeMs: snapshot.ctimeMs + 1 };
            }
            return snapshot;
          },
          read: async (...args) => {
            if (!injected) {
              injected = true;
              if (fault === "rewrite") {
                const writer = await open(file, "r+");
                try { await writer.writeFile(replacement); }
                finally { await writer.close(); }
              }
              if (fault === "truncate") await writeFile(file, "", { flag: "w" });
              if (fault === "append") await writeFile(file, "extra", { flag: "a" });
              if (fault === "chmod") await chmod(file, 0o644);
              if (fault === "link") await link(file, alias);
              if (fault === "early-eof") return { bytesRead: 0 };
            }
            return descriptor.read(...args);
          },
          close: () => descriptor.close(),
        };
      };
      await assert.rejects(readPrivateEnv(file, { openFile }),
        error => error.message.includes("stable private inode"), fault);
      assert.equal(injected, true, fault);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("preflight env rejects interrupted read, fake fstat and missing O_NOFOLLOW without secret exposure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-preflight-env-corruption-"));
  const file = path.join(dir, "runner.env");
  try {
    await writeFile(file, "RUNNER_API_KEY=" + secret, { mode: 0o600 });
    for (const issue of ["bad-length", "changed-inode", "short-read"]) {
      let closeCount = 0;
      const openFile = async (name, flags) => {
        assert.equal(name, file);
        assert.ok(flags & (await import("node:fs")).constants.O_NOFOLLOW);
        const descriptor = await open(name, flags);
        let call = 0;
        return {
          stat: async () => {
            const snapshot = await descriptor.stat();
            if (++call === 2 && issue === "changed-inode")
              return { ...snapshot, isFile: () => true, ino: snapshot.ino + 1 };
            return snapshot;
          },
          read: async (buffer, offset, length, position) => {
            if (issue === "short-read") return { bytesRead: 0 };
            if (issue === "bad-length") return { bytesRead: length + 1 };
            return descriptor.read(buffer, offset, length, position);
          },
          close: async () => { closeCount++; await descriptor.close(); },
        };
      };
      await assert.rejects(readPrivateEnv(file, { openFile }), error =>
        error.message.includes("stable private inode") &&
        !error.message.includes(secret));
      assert.equal(closeCount, 1, "file descriptors must always be closed");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
