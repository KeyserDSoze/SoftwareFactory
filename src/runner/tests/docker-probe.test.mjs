import assert from "node:assert/strict";
import { test } from "node:test";
import { probeRootlessDocker } from "../docker-probe.mjs";

test("Docker rootless probe uses a fixed read-only command, safe environment and no shell", async () => {
  let called = 0;
  const rootless = await probeRootlessDocker({
    host: "unix:///run/docker.sock",
    runDocker: async (args, opts) => {
      called++;
      assert.deepEqual(args, ["info", "--format", "{{json .SecurityOptions}}"]);
      assert.equal(opts.timeout, 5000);
      assert.equal(opts.maxBuffer, 4096);
      assert.equal(opts.env.DOCKER_HOST, "unix:///run/docker.sock");
      assert.equal(opts.env.HOME, "/tmp");
      assert.equal(opts.env.DOCKER_CONFIG, "/tmp");
      assert.ok(!Object.hasOwn(opts.env, "RUNNER_API_KEY"));
      assert.ok(!Object.hasOwn(opts, "shell"));
      return '["name=seccomp,profile=default","name=rootless"]';
    },
  });
  assert.equal(rootless, true);
  assert.equal(called, 1);
  assert.equal(await probeRootlessDocker({
    host: "unix:///run/user/1000/docker.sock",
    runDocker: async () => '["name=rootless"]',
  }), true);
});

test("Docker probe fails closed for rootful and invalid daemons or non-local socket", async () => {
  let called = 0;
  const fake = raw => async () => { called++; return raw; };
  for (const raw of ['["name=seccomp,profile=default"]', "{}", "{garbage",
    '"name=rootless"', '["rootless"]', '["name=rootless",false]',
    "x".repeat(4097)]) {
    assert.equal(await probeRootlessDocker({ runDocker: fake(raw) }), false, raw.slice(0, 30));
  }
  assert.equal(await probeRootlessDocker({
    runDocker: async () => { throw new Error("DOCKER_HOST: sensitive socket path"); },
  }), false);
  const invalidHosts = ["tcp://remote.example.com:2375", "ssh://host",
    "unix:///var/run/docker.sock", "unix:///run/user/1000/../docker.sock", "", "npipe:////./pipe/docker_engine"];
  for (const host of invalidHosts) {
    let invoked = false;
    assert.equal(await probeRootlessDocker({
      host, runDocker: async () => { invoked = true; return '["name=rootless"]'; },
    }), false, host);
    assert.equal(invoked, false, "invalid socket must not invoke Docker CLI");
  }
  assert.ok(called >= 7);
});
