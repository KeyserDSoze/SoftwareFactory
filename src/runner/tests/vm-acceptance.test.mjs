import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPrivateEnv } from "../preflight.mjs";
import { main, runVmAcceptance } from "../scripts/vm-acceptance.mjs";

const image = "node@sha256:" + "a".repeat(64);
const envFile = "/srv/softwarefactory/operator.env";
const id = "c1234567-1234-4234-8234-123456789012";
const compose = { mode: "compose", status: "passed",
  apiLoopbackOnly: true, dockerSocketInWorkerOnly: true,
  tunnelServiceChecked: true };
const host = { mode: "host", status: "passed", uid: 1000,
  directoriesPrivate: true, socketPrivate: true, dockerRootless: true };
const canary = { status: "passed", dockerRootless: true,
  network: "none", readonlyRootfs: true,
  capsDropped: true, cleanup: "verified" };
const privateEnv = Object.freeze({
  RUNNER_API_KEY: "k".repeat(40),
  RUNNER_ALLOWED_ORIGINS: "https://factory.example.net",
});
const receipt = (mode = "inline", operators = false) => ({
  version: 1, scope: "local-vm", status: "passed",
  authMode: mode, operatorRegistry: operators, canaryId: id,
  checks: ["compose", "host", "canary"],
  dockerRootless: true, canaryCleanup: "verified",
});
const flags = (mode, operators) => [
  "--env-file=" + envFile,
  ...(mode === "key-file" ? ["--runner-key-file"] : []),
  ...(mode === "tenants" ? ["--tenants"] : []),
  ...(operators ? ["--operator-registry"] : []),
];
const fixture = (mode = "inline", operators = false) => {
  const calls = [], recovered = [], envReads = [];
  const preflightCheck = async argv => {
    calls.push(["preflight", ...argv]);
    if (argv[0] === "compose") return compose;
    return mode === "inline" && !operators ? host : {
      ...host, credentialMode: mode,
      credentialsPrivate: true, operatorRegistryChecked: operators,
    };
  };
  const canaryCheck = async values => {
    calls.push(["canary", values]);
    return canary;
  };
  const writeRecovery = value => {
    recovered.push(value);
    calls.push(["recovery", value]);
  };
  const readEnv = async filename => {
    envReads.push(filename);
    return { ...privateEnv };
  };
  return { calls, recovered, envReads, readEnv,
    preflightCheck, canaryCheck, writeRecovery };
};

test("VM acceptance checks Compose, host and real rootless canary in that exact order", async () => {
  const f = fixture();
  const result = await runVmAcceptance({
    envFile, image, confirmed: true, uid: 1000, id,
    ...f,
  });
  assert.deepEqual(result, receipt());
  assert.deepEqual(f.envReads, [envFile, envFile, envFile, envFile],
    "secure private env must be checked before and after each gate");
  assert.deepEqual(f.calls, [
    ["preflight", "compose", ...flags("inline", false)],
    ["preflight", "host", ...flags("inline", false)],
    ["recovery", "ROOTLESS_CANARY_ID=" + id + "\n"],
    ["canary", { image, host: "unix:///run/user/1000/docker.sock",
      confirmed: true, id }],
  ]);
  assert.ok(!JSON.stringify(result).includes(envFile));
  assert.ok(!JSON.stringify(result).includes(image));
});

test("VM acceptance forwards the exact reviewed file, tenant and operator profiles", async () => {
  for (const [mode, operators] of [
    ["key-file", false], ["key-file", true],
    ["tenants", false], ["inline", true],
  ]) {
    const f = fixture(mode, operators);
    assert.deepEqual(await runVmAcceptance({
      envFile, image, authMode: mode, operatorRegistry: operators,
      confirmed: true, uid: 1000, id, ...f,
    }), receipt(mode, operators));
    assert.deepEqual(f.calls[0], ["preflight", "compose", ...flags(mode, operators)]);
    assert.deepEqual(f.calls[1], ["preflight", "host", ...flags(mode, operators)]);
    assert.equal(f.calls.filter(x => x[0] === "canary").length, 1);
  }
});

test("invalid UID, missing consent, unsafe paths, image or profile block even read-only checks", async () => {
  const bad = [
    { uid: 0 },
    { uid: 1001 },
    { uid: undefined },
    { confirmed: false },
    { confirmed: "true" },
    { image: "node:22-bookworm-slim" },
    { image: "node@sha256:" + "Z".repeat(64) },
    { image: image + " --privileged" },
    { envFile: "relative.env" },
    { envFile: "/srv/../etc/private.env" },
    { envFile: "/srv/secret\nRUNNER_API_KEY=value" },
    { envFile: "" },
    { authMode: "automatic" },
    { authMode: "tenants", operatorRegistry: true },
    { operatorRegistry: "false" },
    { id: "invalid" },
  ];
  for (const mutation of bad) {
    const f = fixture();
    await assert.rejects(runVmAcceptance({
      envFile, image, confirmed: true, uid: 1000, id, ...f, ...mutation,
    }), /VM acceptance denied/);
    assert.deepEqual(f.calls, [], "invalid input must not call Docker or preflight");
    assert.deepEqual(f.recovered, []);
  }
});

test("Compose proof mismatch and private Compose errors never reach host or canary", async () => {
  for (const response of [
    null, { ...compose, apiLoopbackOnly: false },
    { ...compose, dockerSocketInWorkerOnly: false },
    { ...compose, status: "queued" },
    { ...compose, tunnelServiceChecked: "yes" },
    Error("DOCKER_TOKEN=must-not-leak"),
  ]) {
    const f = fixture(), run = f.preflightCheck;
    f.preflightCheck = async argv => {
      if (response instanceof Error) throw response;
      return response;
    };
    await assert.rejects(runVmAcceptance({
      envFile, image, confirmed: true, uid: 1000, id, ...f,
    }), error => error.message === "VM acceptance denied; manual investigation required");
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.recovered, []);
    void run;
  }
});

test("host privilege, mode and credential-profile mismatches block canary", async () => {
  for (const patch of [
    { uid: 0 }, { dockerRootless: false }, { directoriesPrivate: false },
    { socketPrivate: false }, { status: "failed" },
    { credentialMode: "tenants" }, { credentialsPrivate: false },
    { operatorRegistryChecked: false },
  ]) {
    const f = fixture("key-file", true);
    f.preflightCheck = async argv => {
      f.calls.push(["preflight", ...argv]);
      return argv[0] === "compose" ? compose : {
        ...host, credentialMode: "key-file", credentialsPrivate: true,
        operatorRegistryChecked: true, ...patch,
      };
    };
    await assert.rejects(runVmAcceptance({
      envFile, image, authMode: "key-file", operatorRegistry: true,
      confirmed: true, uid: 1000, id, ...f,
    }), /VM acceptance denied/);
    assert.deepEqual(f.calls.map(x => x[0]), ["preflight", "preflight"]);
    assert.deepEqual(f.recovered, []);
  }
});

test("host internal error is sanitized before printing any canary recovery ID", async () => {
  const f = fixture();
  f.preflightCheck = async argv => {
    f.calls.push(["preflight", ...argv]);
    if (argv[0] === "host") throw Error("RUNNER_API_KEY=private-internal-secret");
    return compose;
  };
  await assert.rejects(runVmAcceptance({
    envFile, image, confirmed: true, uid: 1000, id, ...f,
  }), error => error.message === "VM acceptance denied; manual investigation required");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.recovered, []);
});

test("failing or misleading canary never produces passed receipt; recovery UUID remains", async () => {
  for (const outcome of [
    null, { ...canary, status: "failed" },
    { ...canary, dockerRootless: false },
    { ...canary, cleanup: "unverified" },
    { ...canary, network: "bridge" },
    { ...canary, readonlyRootfs: false },
    { ...canary, capsDropped: false },
    Error("docker private credentials or worker container name"),
  ]) {
    const f = fixture();
    f.canaryCheck = async options => {
      f.calls.push(["canary", options]);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    await assert.rejects(runVmAcceptance({
      envFile, image, confirmed: true, uid: 1000, id, ...f,
    }), error => error.message === "VM acceptance denied; manual investigation required");
    assert.deepEqual(f.recovered, ["ROOTLESS_CANARY_ID=" + id + "\n"]);
    assert.equal(f.calls.at(-1)[0], "canary");
  }
});


test("VM acceptance rejects drift after Compose before any host or canary probe", async () => {
  const f = fixture();
  let reads = 0;
  f.readEnv = async () => {
    reads++;
    return reads === 1 ? privateEnv : { ...privateEnv, RUNNER_API_KEY: "x".repeat(40) };
  };
  await assert.rejects(runVmAcceptance({
    envFile, image, confirmed: true, uid: 1000, id, ...f,
  }), error => error.message === "VM acceptance denied; manual investigation required");
  assert.equal(reads, 2);
  assert.deepEqual(f.calls.map(x => x[0]), ["preflight"]);
  assert.deepEqual(f.recovered, []);
});

test("VM acceptance detects missing or changed key after host, before canary", async () => {
  for (const revision of [
    { ...privateEnv, RUNNER_API_KEY: "z".repeat(40) },
    { RUNNER_ALLOWED_ORIGINS: privateEnv.RUNNER_ALLOWED_ORIGINS },
    null,
  ]) {
    const f = fixture();
    let reads = 0;
    f.readEnv = async () => {
      reads++;
      return reads === 3 ? revision : privateEnv;
    };
    await assert.rejects(runVmAcceptance({
      envFile, image, confirmed: true, uid: 1000, id, ...f,
    }), /VM acceptance denied/);
    assert.equal(reads, 3);
    assert.deepEqual(f.calls.map(x => x[0]), ["preflight", "preflight"]);
    assert.deepEqual(f.recovered, []);
  }
});

test("VM acceptance denies a rotated env after successful canary/cleanup", async () => {
  const f = fixture();
  let reads = 0;
  f.readEnv = async () => {
    reads++;
    return reads === 4
      ? { ...privateEnv, RUNNER_ALLOWED_ORIGINS: "https://other.example.net" }
      : privateEnv;
  };
  await assert.rejects(runVmAcceptance({
    envFile, image, confirmed: true, uid: 1000, id, ...f,
  }), /VM acceptance denied/);
  assert.equal(reads, 4);
  assert.deepEqual(f.calls.map(x => x[0]),
    ["preflight", "preflight", "recovery", "canary"]);
  assert.deepEqual(f.recovered, ["ROOTLESS_CANARY_ID=" + id + "\n"]);
});

test("VM acceptance accepts equivalent reordered env keys without exposing them", async () => {
  const f = fixture();
  let reads = 0;
  f.readEnv = async () => {
    reads++;
    return reads % 2 === 0
      ? { RUNNER_ALLOWED_ORIGINS: privateEnv.RUNNER_ALLOWED_ORIGINS,
          RUNNER_API_KEY: privateEnv.RUNNER_API_KEY }
      : privateEnv;
  };
  const report = await runVmAcceptance({
    envFile, image, confirmed: true, uid: 1000, id, ...f,
  });
  assert.deepEqual(report, receipt());
  assert.equal(reads, 4);
  assert.ok(!JSON.stringify(report).includes(privateEnv.RUNNER_API_KEY));
  assert.ok(!JSON.stringify(report).includes(privateEnv.RUNNER_ALLOWED_ORIGINS));
});

test("VM acceptance fails closed on private env read errors without leaking secrets", async () => {
  for (const at of [1, 2, 3, 4]) {
    const f = fixture();
    let reads = 0;
    f.readEnv = async () => {
      reads++;
      if (reads === at) throw Error("RUNNER_API_KEY=private-secret-never-log");
      return privateEnv;
    };
    await assert.rejects(runVmAcceptance({
      envFile, image, confirmed: true, uid: 1000, id, ...f,
    }), error => error.message === "VM acceptance denied; manual investigation required");
    assert.equal(reads, at);
    assert.equal(f.calls.some(x => x[0] === "canary"), at === 4);
    assert.equal(f.recovered.length, at === 4 ? 1 : 0);
  }
});

test("VM acceptance detects actual atomic private env file rename between gates", {
  skip: process.platform !== "linux",
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-vm-acceptance-"));
  try {
    const filename = path.join(dir, "operator.env");
    const rotated = path.join(dir, "incoming.env");
    await writeFile(filename, "RUNNER_API_KEY=" + "k".repeat(40) + "\n", { mode: 0o600 });
    await writeFile(rotated, "RUNNER_API_KEY=" + "r".repeat(40) + "\n", { mode: 0o600 });
    const f = fixture();
    f.readEnv = readPrivateEnv;
    f.preflightCheck = async argv => {
      f.calls.push(["preflight", ...argv]);
      // Real rename changes the file path to a different private inode.
      if (argv[0] === "compose") {
        await rename(rotated, filename);
        return compose;
      }
      assert.fail("host must not run after env rotation");
    };
    await assert.rejects(runVmAcceptance({
      envFile: filename, image, confirmed: true, uid: 1000, id, ...f,
    }), error => error.message === "VM acceptance denied; manual investigation required");
    assert.deepEqual(f.calls.map(x => x[0]), ["preflight"]);
    assert.deepEqual(f.recovered, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI rejects duplicate, malformed, incomplete or conflicting flags before any action", async () => {
  const valid = ["--env-file=" + envFile, "--image=" + image, "--confirm"];
  const rejected = [
    [], ["--confirm"], valid.slice(0,2),
    [...valid, "--confirm"], [...valid, "--tenants", "--runner-key-file"],
    [...valid, "--tenants", "--operator-registry"],
    [...valid, "--image=" + image], [...valid, "--env-file=" + envFile],
    [...valid, "--foo"], [...valid, "--url=https://runner.example.org"],
    [...valid, "--image=not-a-digest"],
    ["--env-file=relative", ...valid.slice(1)],
    ["--env-file=/srv/../../private", ...valid.slice(1)],
  ];
  for (const argv of rejected) {
    const actions = [];
    await assert.rejects(main(argv, {
      uid: 1000,
      execute: async () => { actions.push("exec"); return receipt(); },
      write: () => actions.push("stdout"),
      writeRecovery: () => actions.push("recovery"),
    }), /VM acceptance denied/);
    assert.deepEqual(actions, [], "must reject before executing preflight");
  }
});

test("CLI receipt is minimal and cannot print a forged or incomplete result", async () => {
  const output = [], recovery = [], calls = [];
  const argv = ["--confirm", "--runner-key-file", "--operator-registry",
    "--image=" + image, "--env-file=" + envFile];
  const result = await main(argv, {
    uid: 1000,
    execute: async options => {
      calls.push(options);
      options.writeRecovery("ROOTLESS_CANARY_ID=" + id + "\n");
      return receipt("key-file", true);
    },
    write: value => output.push(value),
    writeRecovery: value => recovery.push(value),
  });
  assert.deepEqual(result, receipt("key-file", true));
  assert.deepEqual(recovery, ["ROOTLESS_CANARY_ID=" + id + "\n"]);
  assert.equal(output.length, 1);
  assert.ok(output[0].startsWith("RUNNER_VM_ACCEPTANCE_PASS: "));
  assert.deepEqual(JSON.parse(output[0].split(": ")[1]), receipt("key-file", true));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].uid, 1000);
  assert.equal(calls[0].authMode, "key-file");
  assert.equal(calls[0].operatorRegistry, true);
  assert.equal(calls[0].envFile, envFile);
  assert.ok(!output[0].includes(envFile));
  assert.ok(!output[0].includes(image));
  for (const fake of [
    { ...receipt("key-file", true), status: "incomplete" },
    { ...receipt("key-file", true), canaryCleanup: "pending" },
    { ...receipt("key-file", true), authMode: "inline" },
    { ...receipt("key-file", true), checks: ["compose", "canary"] },
  ]) {
    await assert.rejects(main(argv, {
      uid: 1000, execute: async () => fake,
      write: () => assert.fail("no incomplete or forged receipt"),
    }), /VM acceptance denied/);
  }
});
