import assert from "node:assert/strict";
import { test } from "node:test";
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
  const calls = [], recovered = [];
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
  return { calls, recovered, preflightCheck, canaryCheck, writeRecovery };
};

test("VM acceptance checks Compose, host and real rootless canary in that exact order", async () => {
  const f = fixture();
  const result = await runVmAcceptance({
    envFile, image, confirmed: true, uid: 1000, id,
    ...f,
  });
  assert.deepEqual(result, receipt());
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
