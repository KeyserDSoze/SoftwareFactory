import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRootlessCanaryArgs, runRootlessCanary } from "../scripts/rootless-canary.mjs";

const image = "node@sha256:" + "a".repeat(64);
const id = "c1234567-1234-4234-8234-123456789012";
const name = "sf-canary-" + id;
const containerId = "b".repeat(64);
function candidate(state = "created") {
  return {
    Id: containerId, Name: "/" + name,
    Config: { User: "65534:65534",
      Entrypoint: ["node"], Tty: false, OpenStdin: false,
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

test("canary rejects unsafe Docker inspect and never starts the container", async () => {
  const unsafe = [
    { HostConfig: { ...candidate().HostConfig, NetworkMode: "bridge" } },
    { HostConfig: { ...candidate().HostConfig, ReadonlyRootfs: false } },
    { HostConfig: { ...candidate().HostConfig, Privileged: true } },
    { Config: { ...candidate().Config, User: "0:0" } },
    { Config: { ...candidate().Config, Labels: {} } },
    { HostConfig: { ...candidate().HostConfig, Binds: ["/:/host:rw"] } },
    { HostConfig: { ...candidate().HostConfig, CapDrop: [] } },
  ];
  for (const patch of unsafe) {
    const base = candidate(), fake = fakeDocker({ before: { ...base, ...patch } });
    await assert.rejects(runRootlessCanary({
      image, id, confirmed: true, probeDocker: async () => true,
      runDocker: fake.runDocker,
    }), /verification|mismatch|unverified/);
    assert.ok(!fake.calls.some(x => x[0] === "start"), "must fail before executing");
    if (patch.Config?.Labels) assert.ok(!fake.calls.some(x => x[0] === "rm"),
      "foreign container label must never be cleaned automatically");
    else assert.equal(fake.calls.at(-1)?.[0], "rm",
      "verified identity must be cleaned even if security settings rejected");
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
