import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRootlessCanaryArgs, runRootlessCanary } from "../scripts/rootless-canary.mjs";

const image = "node@sha256:" + "a".repeat(64);
const id = "c1234567-1234-4234-8234-123456789012";
const name = "sf-canary-" + id;
const containerId = "b".repeat(64);
const approvedCmd = buildRootlessCanaryArgs(image, name).slice(-2);
function candidate(state = "created") {
  return {
    Id: containerId, Name: "/" + name,
    Config: { User: "65534:65534",
      Entrypoint: ["node"], Cmd: approvedCmd, Tty: false, OpenStdin: false,
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "NODE_VERSION=22.16.0", "YARN_VERSION=1.22.22",
      ],
      Healthcheck: null,
      Labels: { "softwarefactory.canary": name } },
    HostConfig: {
      NetworkMode: "none", ReadonlyRootfs: true, Privileged: false,
      PublishAllPorts: false, PidsLimit: 32, Memory: 134217728,
      NanoCpus: 500000000, CapDrop: ["ALL"], CapAdd: null,
      Binds: null, Mounts: [], VolumesFrom: null, Devices: [],
      PortBindings: null, SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16m" },
    },
    Mounts: [],
    State: { Running: false, Status: state, ExitCode: 0, OOMKilled: false },
  };
}
function fakeDocker({ before = candidate(), after = candidate("exited"),
  startOutput = "SF_ROOTLESS_CANARY_OK\n", failStart = false,
} = {}) {
  const calls = [];
  let inspected = 0;
  return {
    calls,
    async runDocker(args, options) {
      calls.push([...args]);
      assert.equal(options.env.DOCKER_HOST, "unix:///run/docker.sock");
      assert.equal(options.env.HOME, "/tmp");
      assert.equal(options.env.DOCKER_CONFIG, "/tmp");
      assert.ok(!Object.hasOwn(options.env, "RUNNER_API_KEY"));
      assert.ok(!Object.hasOwn(options, "shell"));
      assert.ok(options.timeout > 0 && options.timeout <= 20_000);
      if (args[0] === "create") return containerId + "\n";
      if (args[0] === "inspect") {
        inspected++;
        return JSON.stringify(inspected === 1 ? before : after);
      }
      if (args[0] === "start") {
        if (failStart) throw new Error("sensitive socket error");
        return startOutput;
      }
      if (args[0] === "rm") return containerId + "\n";
      throw Error("unexpected command");
    },
  };
}

test("operator canary requires explicit consent and immutable locally cached Node image", async () => {
  const args = buildRootlessCanaryArgs(image, name);
  assert.equal(args[0], "create");
  for (const flag of ["--pull=never", "--network=none", "--read-only",
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=32", "--memory=128m", "--cpus=0.5",
    "--user=65534:65534", "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m",
    "--entrypoint=node"]) assert.ok(args.includes(flag), flag);
  assert.ok(!args.some(a => a.startsWith("--volume") || a.startsWith("--mount")));
  for (const invalid of ["node:22-bookworm-slim", "ubuntu@sha256:" + "a".repeat(64),
    "node@sha256:" + "x".repeat(64), image + " --privileged"])
    assert.throws(() => buildRootlessCanaryArgs(invalid, name));
  let calls = 0;
  await assert.rejects(runRootlessCanary({ image, confirmed: false,
    id, runDocker: async () => { calls++; return ""; } }), /explicit --confirm/);
  assert.equal(calls, 0);
});

test("canary refuses rootful daemon and non-local Docker host before create", async () => {
  let calls = 0;
  const execute = async () => { calls++; return containerId; };
  await assert.rejects(runRootlessCanary({
    image, id, confirmed: true, probeDocker: async () => false, runDocker: execute,
  }), /rootless daemon/);
  await assert.rejects(runRootlessCanary({
    image, id, confirmed: true, host: "tcp://remote:2375",
    probeDocker: async () => true, runDocker: execute,
  }), /non-local/);
  assert.equal(calls, 0);
});

test("rootless canary verifies create, daemon configuration, execution and targeted cleanup", async () => {
  const fake = fakeDocker();
  const report = await runRootlessCanary({
    image, id, confirmed: true, probeDocker: async () => true,
    runDocker: fake.runDocker,
  });
  assert.deepEqual(report, { status: "passed", dockerRootless: true,
    network: "none", readonlyRootfs: true, capsDropped: true, cleanup: "verified" });
  assert.deepEqual(fake.calls.map(x => x[0]), ["create", "inspect", "start", "inspect", "inspect", "rm"]);
  assert.equal(fake.calls[0][fake.calls[0].indexOf("--name") + 1], name);
  assert.deepEqual(fake.calls.at(-1), ["rm", "-f", containerId]);
  assert.equal(fake.calls[2][1], "--attach");
});

test("canary probes rootless mode independently before every Docker command including rm", async () => {
  const fake = fakeDocker();
  const observedHosts = [];
  const result = await runRootlessCanary({
    image, id, confirmed: true,
    probeDocker: async ({ host }) => { observedHosts.push(host); return true; },
    runDocker: fake.runDocker,
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(fake.calls.map(x => x[0]),
    ["create", "inspect", "start", "inspect", "inspect", "rm"]);
  assert.deepEqual(observedHosts,
    Array(fake.calls.length).fill("unix:///run/docker.sock"),
    "each individual command must have its own fresh rootless proof");
});

test("rootless lost before first inspect: no start, no unverified rm, manual reconciliation", async () => {
  const fake = fakeDocker();
  let checks = 0;
  await assert.rejects(runRootlessCanary({
    image, id, confirmed: true,
    probeDocker: async () => ++checks === 1,
    runDocker: fake.runDocker,
  }), /manual investigation required/);
  assert.equal(checks, 2,
    "do not run cleanup without first verifying this container's identity");
  assert.deepEqual(fake.calls.map(x => x[0]), ["create"]);
});

test("rootless lost before start: no execution and no unsafe cleanup", async () => {
  const fake = fakeDocker();
  let checks = 0;
  await assert.rejects(runRootlessCanary({
    image, id, confirmed: true,
    probeDocker: async () => ++checks <= 2,
    runDocker: fake.runDocker,
  }), /manual investigation required/);
  assert.equal(checks, 4, "cleanup still checks rootless independently");
  assert.deepEqual(fake.calls.map(x => x[0]), ["create", "inspect"]);
  assert.ok(!fake.calls.some(x => x[0] === "start" || x[0] === "rm"));
});

test("rootless recovered after a denied start may clean its verified container, but never passes", async () => {
  const fake = fakeDocker();
  let checks = 0;
  await assert.rejects(runRootlessCanary({
    image, id, confirmed: true,
    probeDocker: async () => ++checks !== 3,
    runDocker: fake.runDocker,
  }), /rootless daemon/);
  assert.equal(checks, 5);
  assert.deepEqual(fake.calls.map(x => x[0]),
    ["create", "inspect", "inspect", "rm"]);
  assert.ok(!fake.calls.some(x => x[0] === "start"));
});

test("rootless lost or probe throws immediately before rm: never delete or certify", async () => {
  for (const denied of [
    async () => false,
    async () => { throw Error("Docker secret=never-print, private socket!"); },
    async () => "true",
  ]) {
    const fake = fakeDocker();
    let checks = 0;
    await assert.rejects(runRootlessCanary({
      image, id, confirmed: true,
      probeDocker: async options => {
        checks++;
        assert.equal(options.host, "unix:///run/docker.sock");
        return checks === 6 ? denied() : true;
      },
      runDocker: fake.runDocker,
    }), err => err.message ===
      "Rootless canary cleanup failed; manual investigation required");
    assert.equal(checks, 6);
    assert.deepEqual(fake.calls.map(x => x[0]),
      ["create", "inspect", "start", "inspect", "inspect"]);
    assert.ok(!fake.calls.some(x => x[0] === "rm"));
  }
});

test("rootless probe errors are sanitized before first Docker spawn", async () => {
  let calls = 0;
  await assert.rejects(runRootlessCanary({
    image, id, confirmed: true,
    probeDocker: async () => {
      throw Error("DOCKER_HOST=private; bearer=super-secret");
    },
    runDocker: async () => { calls++; return containerId; },
  }), error => error.message === "Rootless canary requires a confirmed rootless daemon");
  assert.equal(calls, 0);
});

test("canary rejects unsafe Docker inspect and never starts the container", async () => {
  const unsafe = [
    { HostConfig: { ...candidate().HostConfig, NetworkMode: "bridge" } },
    { HostConfig: { ...candidate().HostConfig, ReadonlyRootfs: false } },
    { HostConfig: { ...candidate().HostConfig, Privileged: true } },
    { Config: { ...candidate().Config, User: "0:0" } },
    { Config: { ...candidate().Config, Labels: {} } },
    { HostConfig: { ...candidate().HostConfig, Binds: ["/:/host:rw"] } },
    { HostConfig: { ...candidate().HostConfig, CapDrop: [] } },
    { Config: { ...candidate().Config, Cmd: ["-e", "console.log('SF_ROOTLESS_CANARY_OK')"] } },
    { Config: { ...candidate().Config, Cmd: ["--version"] } },
    { Config: { ...candidate().Config, Cmd: [] } },
    { Config: { ...candidate().Config, Env: [] } },
    { Config: { ...candidate().Config, Env: null } },
    { Config: { ...candidate().Config, Env: [
      ...candidate().Config.Env, "NODE_OPTIONS=--require=/tmp/preload.js"] } },
    { Config: { ...candidate().Config, Env: [
      ...candidate().Config.Env, "NODE_PATH=/tmp"] } },
    { Config: { ...candidate().Config, Env: [
      ...candidate().Config.Env, "LD_PRELOAD=/lib/evil.so"] } },
    { Config: { ...candidate().Config, Env: [
      ...candidate().Config.Env, "LD_LIBRARY_PATH=/tmp"] } },
    { Config: { ...candidate().Config, Env: [
      ...candidate().Config.Env, "HOME=/tmp"] } },
    { Config: { ...candidate().Config, Env: [
      "PATH=/tmp:/bin", ...candidate().Config.Env.slice(1)] } },
    { Config: { ...candidate().Config, Env: [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NODE_VERSION=23.0.0", "YARN_VERSION=1.22.22"] } },
    { Config: { ...candidate().Config, Env: [
      ...candidate().Config.Env.slice(0,2), "YARN_VERSION=2.0.0"] } },
    { Config: { ...candidate().Config, Env: [
      ...candidate().Config.Env.slice(0,2), "NODE_VERSION=22.16.0"] } },
    { Config: { ...candidate().Config, Env: [
      ...candidate().Config.Env.slice(0,2), "YARN_VERSION=1.22.22\nNODE_OPTIONS=--require=/tmp/preload"] } },
    { Config: { ...candidate().Config, Healthcheck: {
      Test: ["CMD-SHELL", "cat /run/secrets/private"] } } },
    { Config: { ...candidate().Config, Healthcheck: {} } },
    { HostConfig: { ...candidate().HostConfig, SecurityOpt: [
      "no-new-privileges:true", "seccomp=unconfined"] } },
    { HostConfig: { ...candidate().HostConfig, SecurityOpt: [
      "no-new-privileges", "apparmor=unconfined"] } },
    { HostConfig: { ...candidate().HostConfig, SecurityOpt: [
      "no-new-privileges:true", "no-new-privileges:true"] } },
    { HostConfig: { ...candidate().HostConfig, PidMode: "host" } },
    { HostConfig: { ...candidate().HostConfig, IpcMode: "host" } },
    { HostConfig: { ...candidate().HostConfig, UTSMode: "host" } },
    { HostConfig: { ...candidate().HostConfig, UsernsMode: "host" } },
    { HostConfig: { ...candidate().HostConfig, CgroupnsMode: "host" } },
    { HostConfig: { ...candidate().HostConfig, DeviceRequests: [{ Driver: "nvidia" }] } },
    { HostConfig: { ...candidate().HostConfig, GroupAdd: ["docker"] } },
    { HostConfig: { ...candidate().HostConfig, Dns: ["203.0.113.53"] } },
    { HostConfig: { ...candidate().HostConfig, ExtraHosts: ["origin:203.0.113.9"] } },
    { HostConfig: { ...candidate().HostConfig, Sysctls: { "net.ipv4.ip_forward": "1" } } },
    { HostConfig: { ...candidate().HostConfig, CgroupParent: "/host" } },
    { HostConfig: { ...candidate().HostConfig, Tmpfs: {
      "/tmp": "rw,nosuid,nodev,noexec,size=16m", "/etc": "rw" } } },
  ];
  for (const patch of unsafe) {
    const base = candidate(), fake = fakeDocker({ before: { ...base, ...patch } });
    await assert.rejects(runRootlessCanary({
      image, id, confirmed: true, probeDocker: async () => true,
      runDocker: fake.runDocker,
    }), /verification|mismatch|unverified/);
    assert.ok(!fake.calls.some(x => x[0] === "start"), "must fail before executing");
    // A changed UID is an unsafe CONFIG but does not change ownership:
    // cleanup is still mandatory. Only an unknown label makes cleanup unsafe.
    const foreignLabel = patch.Config?.Labels &&
      patch.Config.Labels["softwarefactory.canary"] !== name;
    if (foreignLabel) assert.ok(!fake.calls.some(x => x[0] === "rm"),
      "foreign container label must never be cleaned automatically");
    else assert.equal(fake.calls.at(-1)?.[0], "rm",
      "verified identity must be cleaned even if security settings rejected");
  }
});


test("canary accepts only inert Docker namespace defaults and one NNP option", async () => {
  for (const [key, value] of [
    ["PidMode", ""], ["PidMode", "private"], ["IpcMode", "private"],
    ["UTSMode", ""], ["UsernsMode", ""], ["CgroupnsMode", "private"],
  ]) {
    const before = candidate(); before.HostConfig[key] = value;
    const after = { ...before, State: candidate("exited").State };
    const mock = fakeDocker({ before, after });
    const report = await runRootlessCanary({ image, id, confirmed: true,
      probeDocker: async () => true, runDocker: mock.runDocker });
    assert.equal(report.status, "passed", key + " " + value);
  }
  const before = candidate();
  before.HostConfig.SecurityOpt = ["no-new-privileges"];
  const mock = fakeDocker({ before,
    after: { ...before, State: candidate("exited").State } });
  assert.equal((await runRootlessCanary({ image, id, confirmed: true,
    probeDocker: async () => true, runDocker: mock.runDocker })).status, "passed");
});


test("canary accepts reordered official image env without loader hooks or healthcheck", async () => {
  const before = candidate();
  before.Config.Env = [...before.Config.Env].reverse();
  const after = candidate("exited");
  after.Config.Env = [...after.Config.Env].reverse();
  const fake = fakeDocker({ before, after });
  assert.equal((await runRootlessCanary({
    image, id, confirmed: true, probeDocker: async () => true,
    runDocker: fake.runDocker,
  })).status, "passed");
});

test("canary denies late injected Node preload or healthcheck after start", async () => {
  for (const bad of [
    c => { c.Config.Env.push("NODE_OPTIONS=--import=/tmp/preload.mjs"); },
    c => { c.Config.Healthcheck = { Test: ["CMD", "node", "-e", "process.exit(0)"] }; },
  ]) {
    const after = candidate("exited");
    bad(after);
    const fake = fakeDocker({ after });
    await assert.rejects(runRootlessCanary({
      image, id, confirmed: true, probeDocker: async () => true,
      runDocker: fake.runDocker,
    }), /verification|mismatch|cleanup/);
    assert.deepEqual(fake.calls.map(args => args[0]),
      ["create", "inspect", "start", "inspect", "inspect", "rm"]);
  }
});

test("canary rejects stdout spoofing, start timeouts and nonzero container exit", async () => {
  for (const options of [
    { startOutput: "CANARY_OK\n" },
    { startOutput: "SF_ROOTLESS_CANARY_OK\nunauthorized" },
    { failStart: true },
    { after: { ...candidate("exited"), State: {
      ...candidate("exited").State, ExitCode: 1 } } },
  ]) {
    const fake = fakeDocker(options);
    await assert.rejects(runRootlessCanary({
      image, id, confirmed: true, probeDocker: async () => true,
      runDocker: fake.runDocker,
    }));
    assert.equal(fake.calls.at(-1)?.[0], "rm");
  }
});
