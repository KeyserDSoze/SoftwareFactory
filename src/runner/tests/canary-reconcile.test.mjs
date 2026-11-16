import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { main, reconcileRootlessCanary } from "../scripts/canary-reconcile.mjs";
import { buildRootlessCanaryArgs } from "../scripts/rootless-canary.mjs";

const canaryId = "c1234567-1234-4234-8234-123456789012";
const name = "sf-canary-" + canaryId;
const id = "a".repeat(64);
const other = "b".repeat(64);
const approvedCmd = buildRootlessCanaryArgs(
  "node@sha256:" + "a".repeat(64), name).slice(-2);

function candidate({ dockerId = id, nameOverride = name,
  label = name, state = "created", running = false,
  extraLabels = {}, unsafe = {} } = {}) {
  return {
    Id: dockerId, Name: "/" + nameOverride,
    Config: {
      User: "65534:65534", Entrypoint: ["node"], Cmd: approvedCmd,
      Tty: false, OpenStdin: false,
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "NODE_VERSION=22.16.0", "YARN_VERSION=1.22.22",
      ],
      Healthcheck: null,
      Labels: { "softwarefactory.canary": label, ...extraLabels },
    },
    HostConfig: {
      NetworkMode: "none", ReadonlyRootfs: true, Privileged: false,
      PublishAllPorts: false, PidsLimit: 32, Memory: 134217728,
      NanoCpus: 500000000, CapDrop: ["ALL"], CapAdd: null,
      Binds: null, Mounts: [], VolumesFrom: null, Devices: [],
      PortBindings: null, SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16m" },
      ...unsafe,
    },
    Mounts: [], State: { Running: running, Status: state, ExitCode: 0 },
  };
}
function mockDocker({ first = candidate(), second = candidate(),
  listing = id.slice(0, 12) + "\n", rmOutput = id + "\n",
  failures = {}, probe = async () => true } = {}) {
  const calls = [], probes = [];
  let inspected = 0;
  const runDocker = async (args, opts) => {
    calls.push([...args]);
    assert.equal(opts.timeout, 8000);
    assert.equal(opts.maxBuffer, 65536);
    assert.deepEqual(Object.keys(opts.env).sort(),
      ["DOCKER_CONFIG", "DOCKER_HOST", "HOME", "PATH"]);
    assert.equal(opts.env.HOME, "/tmp");
    assert.equal(opts.env.DOCKER_CONFIG, "/tmp");
    assert.equal(opts.env.DOCKER_HOST, "unix:///run/docker.sock");
    assert.equal(opts.shell, undefined);
    if (failures[args[0]]) throw Error("private-token=must-never-leak");
    if (args[0] === "ps") {
      assert.deepEqual(args, [
        "ps", "-a", "--filter", "label=softwarefactory.canary=" + name,
        "--format", "{{.ID}}",
      ]);
      return listing;
    }
    if (args[0] === "inspect") {
      assert.deepEqual(args.slice(0, 3), ["inspect", "--format", "{{json .}}"]);
      return JSON.stringify(++inspected === 1 ? first : second);
    }
    if (args[0] === "rm") {
      assert.deepEqual(args, ["rm", "-f", id]);
      return rmOutput;
    }
    throw Error("unexpected operation");
  };
  const probeDocker = async ({ host }) => {
    probes.push(host);
    return probe(probes.length);
  };
  return { calls, probes, runDocker, probeDocker };
}

test("canary cleanup defaults to read-only, verifies full canary identity, never touches job containers", async () => {
  const fake = mockDocker();
  const result = await reconcileRootlessCanary({ canaryId,
    runDocker: fake.runDocker, probeDocker: fake.probeDocker });
  assert.deepEqual(result, {
    canaryId, found: true, eligible: true, applied: false,
    container: { id, name, state: "created" }, removed: [],
  });
  assert.deepEqual(fake.calls.map(x => x[0]), ["ps", "inspect"]);
  assert.equal(fake.probes.length, 2);
  assert.ok(fake.probes.every(v => v === "unix:///run/docker.sock"));
  assert.ok(!fake.calls.some(x => x[0] === "rm"));
});

test("confirmed cleanup requires two matching immutable ID inspect snapshots and fresh rootless checks", async () => {
  const fake = mockDocker();
  const result = await reconcileRootlessCanary({ canaryId,
    apply: true, confirmCanary: canaryId,
    runDocker: fake.runDocker, probeDocker: fake.probeDocker });
  assert.equal(result.applied, true);
  assert.deepEqual(result.removed, [id]);
  assert.deepEqual(fake.calls, [
    ["ps", "-a", "--filter", "label=softwarefactory.canary=" + name,
      "--format", "{{.ID}}"],
    ["inspect", "--format", "{{json .}}", id.slice(0, 12)],
    ["inspect", "--format", "{{json .}}", id],
    ["rm", "-f", id],
  ]);
  assert.equal(fake.probes.length, 4);
});

test("missing canary is a harmless no-op even when confirmed", async () => {
  const fake = mockDocker({ listing: "" });
  const result = await reconcileRootlessCanary({
    canaryId, apply: true, confirmCanary: canaryId,
    runDocker: fake.runDocker, probeDocker: fake.probeDocker,
  });
  assert.deepEqual(result, {
    canaryId, found: false, eligible: false, applied: false, removed: [],
  });
  assert.deepEqual(fake.calls.map(x => x[0]), ["ps"]);
});

test("confirmation, UUID, rootless local socket and boolean apply are fail-closed", async () => {
  const invalid = [
    { canaryId: "wrong" },
    { canaryId, apply: true },
    { canaryId, apply: true, confirmCanary: randomUUID() },
    { canaryId, confirmCanary: canaryId },
    { canaryId, apply: "true" },
    { canaryId, host: "unix:///var/run/docker.sock" },
    { canaryId, host: "tcp://example.com:2375" },
    { canaryId, host: "ssh://example.com" },
  ];
  for (const params of invalid) {
    const fake = mockDocker();
    await assert.rejects(reconcileRootlessCanary({
      ...params, runDocker: fake.runDocker, probeDocker: fake.probeDocker,
    }), /Canary reconciliation denied/);
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.probes.length, 0);
  }
});

test("never delete spoofed canaries, running containers or unsafe mount/network profiles", async () => {
  const invalid = [
    candidate({ dockerId: other }),
    candidate({ label: "sf-canary-" + randomUUID() }),
    candidate({ nameOverride: "unrelated" }),
    candidate({ state: "running", running: true }),
    candidate({ state: "restarting" }),
    candidate({ unsafe: { NetworkMode: "bridge" } }),
    candidate({ unsafe: { Privileged: true } }),
    candidate({ unsafe: { Binds: ["/:/host:rw"] } }),
    candidate({ unsafe: { PidMode: "host" } }),
    candidate({ unsafe: { IpcMode: "host" } }),
    candidate({ unsafe: { UsernsMode: "host" } }),
    candidate({ unsafe: { CgroupnsMode: "host" } }),
    candidate({ unsafe: { SecurityOpt: [
      "no-new-privileges", "seccomp=unconfined"] } }),
    candidate({ unsafe: { Dns: ["203.0.113.53"] } }),
    { ...candidate(), Config: { ...candidate().Config,
      Cmd: ["-e", "console.log('SF_ROOTLESS_CANARY_OK')"] } },
    { ...candidate(), Config: { ...candidate().Config,
      Env: [...candidate().Config.Env, "NODE_OPTIONS=--require=/tmp/evil"] } },
    { ...candidate(), Config: { ...candidate().Config,
      Env: [...candidate().Config.Env.slice(0,2), "NODE_VERSION=22.16.0"] } },
    { ...candidate(), Config: { ...candidate().Config,
      Healthcheck: { Test: ["CMD", "true"] } } },
    candidate({ extraLabels: { "softwarefactory.runner": "job" } }),
  ];
  for (const before of invalid) {
    const fake = mockDocker({ first: before });
    await assert.rejects(reconcileRootlessCanary({
      canaryId, apply: true, confirmCanary: canaryId,
      runDocker: fake.runDocker, probeDocker: fake.probeDocker,
    }), /Canary reconciliation denied/);
    assert.deepEqual(fake.calls.map(x => x[0]), ["ps", "inspect"]);
  }
  for (const listing of [
    "not-an-id\n", id.slice(0, 12) + "\n" + other.slice(0, 12) + "\n",
  ]) {
    const fake = mockDocker({ listing });
    await assert.rejects(reconcileRootlessCanary({ canaryId,
      runDocker: fake.runDocker, probeDocker: fake.probeDocker,
    }), /Canary reconciliation denied/);
    assert.deepEqual(fake.calls.map(x => x[0]), ["ps"]);
  }
});

test("full-ID replacement and state transition between inspect and rm are rejected", async () => {
  for (const after of [
    candidate({ dockerId: other }), candidate({ state: "running", running: true }),
    candidate({ state: "exited" }), candidate({ nameOverride: "wrong" }),
    candidate({ label: "other" }),
  ]) {
    const fake = mockDocker({ second: after });
    await assert.rejects(reconcileRootlessCanary({
      canaryId, apply: true, confirmCanary: canaryId,
      runDocker: fake.runDocker, probeDocker: fake.probeDocker,
    }), /Canary reconciliation denied/);
    assert.deepEqual(fake.calls.map(x => x[0]),
      ["ps", "inspect", "inspect"], "no deletion after a changed identity/state");
  }
});

test("daemon rootless must remain true for every ps/inspect/rm, especially before deletion", async () => {
  for (const deniedAt of [1, 2, 3, 4]) {
    const fake = mockDocker({ probe: n => n === deniedAt ? false : true });
    await assert.rejects(reconcileRootlessCanary({
      canaryId, apply: true, confirmCanary: canaryId,
      runDocker: fake.runDocker, probeDocker: fake.probeDocker,
    }), /Canary reconciliation denied/);
    assert.equal(fake.probes.length, deniedAt);
    assert.equal(fake.calls.length, deniedAt - 1);
    assert.equal(fake.calls.some(x => x[0] === "rm"), false);
  }
  for (const fault of ["ps", "inspect", "rm"]) {
    const fake = mockDocker({ failures: { [fault]: true } });
    await assert.rejects(reconcileRootlessCanary({
      canaryId, apply: true, confirmCanary: canaryId,
      runDocker: fake.runDocker, probeDocker: fake.probeDocker,
    }), err => err.message ===
      "Canary reconciliation denied; manual investigation required");
  }
});

test("rm requires exact full-ID acknowledgement, and no false success after uncertain cleanup", async () => {
  const fake = mockDocker({ rmOutput: "unrelated-container\n" });
  await assert.rejects(reconcileRootlessCanary({
    canaryId, apply: true, confirmCanary: canaryId,
    runDocker: fake.runDocker, probeDocker: fake.probeDocker,
  }), /Canary reconciliation denied/);
  assert.deepEqual(fake.calls.at(-1), ["rm", "-f", id]);
});

test("CLI rejects root user and mismatched, duplicate or malformed flags before calling Docker", async () => {
  const badArguments = [
    [], ["--canary=bad"], ["--apply"], ["--canary=" + canaryId, "--apply"],
    ["--canary=" + canaryId, "--confirm-canary=" + canaryId],
    ["--canary=" + canaryId, "--canary=" + canaryId],
    ["--canary=" + canaryId, "--apply", "--confirm-canary=" + randomUUID()],
    ["--canary=" + canaryId, "--apply", "--apply"],
  ];
  for (const argv of badArguments) {
    let count = 0;
    await assert.rejects(main(argv, {
      uid: 1000, reconcile: async () => { count++; return {}; }, write: () => {},
    }), /Canary reconciliation denied/);
    assert.equal(count, 0);
  }
  await assert.rejects(main(["--canary=" + canaryId], {
    uid: 0, reconcile: async () => { throw Error("not called"); },
  }), /Canary reconciliation denied/);
  const calls = [], outputs = [];
  const fake = async params => {
    calls.push(params);
    return { found: false, removed: [] };
  };
  await main(["--canary=" + canaryId], {
    uid: 1000, reconcile: fake, write: text => outputs.push(text),
  });
  await main(["--canary=" + canaryId, "--apply",
    "--confirm-canary=" + canaryId], {
    uid: 1000, reconcile: fake, write: text => outputs.push(text),
  });
  assert.deepEqual(calls, [
    { canaryId, apply: false, confirmCanary: null },
    { canaryId, apply: true, confirmCanary: canaryId },
  ]);
  assert.deepEqual(outputs, [
    '{"found":false,"removed":[]}\n',
    '{"found":false,"removed":[]}\n',
  ]);
});
