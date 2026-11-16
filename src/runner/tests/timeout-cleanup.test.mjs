import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { runnerContainerIdentity } from "../orphans.mjs";
import { cleanupTimedOutRunnerContainer } from "../timeout-cleanup.mjs";
import { runDockerStep } from "../docker.mjs";

const jobId = "a1234567-1111-4111-8111-111111111111";
const step = "dotnet-build", id = "a".repeat(64), replacement = "b".repeat(64);
const identity = runnerContainerIdentity(jobId, step);
const snapshot = (dockerId = id, name = identity.name,
  labels = Object.fromEntries(identity.labels)) =>
  JSON.stringify([{ Id: dockerId, Name: "/" + name, Config: { Labels: labels } }]);

test("timeout cleanup removes only the twice-inspected full ID with fresh rootless checks", async () => {
  const calls = []; let probes = 0;
  const removed = await cleanupTimedOutRunnerContainer(jobId, step, {
    probeDocker: async () => { probes++; return true; },
    runDocker: async (args, opts) => {
      calls.push(args);
      assert.equal(opts.timeout, 5000);
      assert.equal(opts.maxBuffer, 8192);
      assert.equal(opts.env.DOCKER_CONFIG, "/tmp");
      assert.equal(opts.env.DOCKER_HOST, "unix:///run/docker.sock");
      assert.ok(!Object.hasOwn(opts.env, "RUNNER_API_KEY"));
      return args[0] === "inspect" ? snapshot() : id + "\n";
    },
  });
  assert.equal(removed, true);
  assert.equal(probes, 2);
  assert.deepEqual(calls, [
    ["inspect", "--type", "container", identity.name],
    ["inspect", "--type", "container", id],
    ["rm", "-f", id],
  ]);
});

test("malformed, wrong-label, foreign-name and changed-ID containers cannot be removed", async () => {
  const wrong = [
    "not JSON", "[]", JSON.stringify([{}, {}]),
    snapshot("invalid"), snapshot(id, "foreign"),
    snapshot(id, identity.name, { "softwarefactory.runner": "other" }),
    snapshot(id, identity.name, { ...Object.fromEntries(identity.labels),
      "softwarefactory.job-id": randomUUID() }),
    "x".repeat(8193),
  ];
  for (const body of wrong) {
    const calls = [];
    assert.equal(await cleanupTimedOutRunnerContainer(jobId, step, {
      probeDocker: async () => true,
      runDocker: async args => { calls.push(args); return body; },
    }), false);
    assert.deepEqual(calls.map(x => x[0]), ["inspect"]);
  }
  for (const body of [snapshot(replacement), snapshot(id, "foreign"), "invalid"]) {
    const calls = [];
    assert.equal(await cleanupTimedOutRunnerContainer(jobId, step, {
      probeDocker: async () => true,
      runDocker: async args => {
        calls.push(args); return args.at(-1) === identity.name ? snapshot() : body;
      },
    }), false);
    assert.deepEqual(calls.map(x => x[0]), ["inspect", "inspect"]);
  }
});

test("rootful, changed daemon, unsafe socket and Docker errors never trigger rm", async () => {
  for (const host of ["tcp://host:2375", "unix:///var/run/docker.sock", "ssh://host"]) {
    let calls = 0;
    assert.equal(await cleanupTimedOutRunnerContainer(jobId, step, {
      host, probeDocker: async () => { calls++; return true; },
      runDocker: async () => { calls++; return snapshot(); },
    }), false);
    assert.equal(calls, 0);
  }
  for (const probeDocker of [
    async () => false, async () => { throw Error("secret=private"); },
  ]) {
    let calls = 0;
    assert.equal(await cleanupTimedOutRunnerContainer(jobId, step, {
      probeDocker, runDocker: async () => { calls++; return snapshot(); },
    }), false);
    assert.equal(calls, 0);
  }
  let probes = 0, calls = [];
  assert.equal(await cleanupTimedOutRunnerContainer(jobId, step, {
    probeDocker: async () => ++probes === 1,
    runDocker: async args => { calls.push(args); return snapshot(); },
  }), false);
  assert.equal(probes, 2);
  assert.deepEqual(calls.map(x => x[0]), ["inspect", "inspect"]);
  for (const command of ["inspect", "rm"]) {
    calls = [];
    assert.equal(await cleanupTimedOutRunnerContainer(jobId, step, {
      probeDocker: async () => true,
      runDocker: async args => {
        calls.push(args);
        if (args[0] === command) throw Error("token=secret");
        return snapshot();
      },
    }), false);
    assert.equal(calls.at(-1)[0], command);
  }
});

const plan = {
  image: "node:22-bookworm-slim",
  command: ["node", "-e", "process.exit(0)"],
  args: ["run", "--rm", "--network", "none", "node:22-bookworm-slim", "node"],
  timeoutMs: 10,
};

test("timeout awaits cleanup even if killed CLI never emits close", async () => {
  let killed = 0, cleaned = false, spawns = 0;
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = signal => { assert.equal(signal, "SIGKILL"); killed++; };
  const result = await runDockerStep(plan, jobId, step, {
    probeDocker: async () => true,
    spawnProcess: () => { spawns++; return child; },
    cleanupTimedOutContainer: async (uuid, s, { probeDocker }) => {
      assert.equal(uuid, jobId);
      assert.equal(s, step);
      assert.equal(await probeDocker(), true);
      await new Promise(resolve => setTimeout(resolve, 25));
      cleaned = true;
    },
  });
  assert.equal(killed, 1); assert.equal(spawns, 1);
  assert.equal(cleaned, true);
  assert.equal(result.state, "failed");
  assert.equal(result.exitCode, null); assert.equal(result.timedOut, true);
  assert.equal(result.cleanupVerified, false,
    "a void cleanup callback is not proof of container removal");
});

test("synchronous close on SIGKILL cannot finish before cleanup or report a pass", async () => {
  let cleaned = false;
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => { child.emit("close", 0); };
  const result = await runDockerStep(plan, jobId, step, {
    probeDocker: async () => true,
    spawnProcess: () => child,
    cleanupTimedOutContainer: async () => {
      await new Promise(resolve => setTimeout(resolve, 20)); cleaned = true;
    },
  });
  assert.equal(cleaned, true);
  assert.equal(result.state, "failed");
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.cleanupVerified, false);
});

// Timeout does not certify a code failure; even successful Docker rm cannot
// turn a timed-out step into a passing test, but it can authorize normal TTL.
test("verified cleanup requires exact true and survives synchronous close", async () => {
  for (const [answer, verified] of [
    [true, true], [false, false], [undefined, false],
    ["true", false], [null, false],
  ]) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.emit("close", 0); };
    const result = await runDockerStep(plan, jobId, step, {
      probeDocker: async () => true,
      spawnProcess: () => child,
      cleanupTimedOutContainer: async () => answer,
    });
    assert.equal(result.state, "failed");
    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, true);
    assert.equal(result.cleanupVerified, verified);
  }
});

test("cleanup exception is not proof, timeout remains unverified", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit("close", null);
  const result = await runDockerStep(plan, jobId, step, {
    probeDocker: async () => true,
    spawnProcess: () => child,
    cleanupTimedOutContainer: async () => {
      throw Error("private Docker socket and secret");
    },
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.cleanupVerified, false);
  assert.equal(result.exitCode, null);
  assert.doesNotMatch(JSON.stringify(result), /private Docker socket and secret/);
});
