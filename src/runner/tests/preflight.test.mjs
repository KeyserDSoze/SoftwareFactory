import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, chmod, link, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectComposeConfig, inspectHost, inspectHostPath, probeEndpoint,
  readPrivateEnv, validateHostEnvironment, main,
  isPrivateEnvFile, isStablePrivateEnvSnapshot,
  readHostCredential, selectEndpointBearer,
} from "../preflight.mjs";

const secret = "s".repeat(48);
const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const apiEnv = { RUNNER_API_KEY: secret,
  RUNNER_ALLOWED_ORIGINS: "https://factory.example.com",
  RUNNER_DATA_DIR: "/srv/softwarefactory/runner-data",
  RUNNER_HOST_WORK_DIR: "/srv/softwarefactory/workspaces",
  RUNNER_DOCKER_SOCKET: "/run/user/1000/docker.sock",
};
function service(extra = {}) {
  return { user: "1000:1000", read_only: true,
    security_opt: ["no-new-privileges:true"], cap_drop: ["ALL"],
    networks: { default: null }, ...extra };
}
function composeConfig() {
  return { name: "runner", networks: { default: { name: "runner_default" } },
    services: {
    "runner-api": service({
      build: { context: checkoutRoot, dockerfile: "docker/runner/Dockerfile.api" },
      volumes: [{ type: "bind", source: apiEnv.RUNNER_DATA_DIR, target: "/data" }],
      ports: [{ host_ip: "127.0.0.1", target: 8787, published: "8787", protocol: "tcp" }],
      environment: { RUNNER_PORT: "8787", RUNNER_API_KEY: secret,
        RUNNER_DATA_DIR: "/data" },
    }),
    "runner-worker": service({
      build: { context: checkoutRoot, dockerfile: "docker/runner/Dockerfile.worker" },
      volumes: [
        { type: "bind", source: apiEnv.RUNNER_DATA_DIR, target: "/data" },
        { type: "bind", source: apiEnv.RUNNER_HOST_WORK_DIR, target: apiEnv.RUNNER_HOST_WORK_DIR },
        { type: "bind", source: apiEnv.RUNNER_DOCKER_SOCKET, target: "/run/docker.sock" },
      ],
      environment: { DOCKER_HOST: "unix:///run/docker.sock",
        RUNNER_DATA_DIR: "/data",
        RUNNER_HOST_WORK_DIR: apiEnv.RUNNER_HOST_WORK_DIR },
    }),
    cloudflared: {
      image: "cloudflare/cloudflared:latest",
      cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
      profiles: ["tunnel"], networks: { default: null },
      user: "1000:1000", read_only: true,
      command: ["tunnel", "--no-autoupdate", "run", "--token", "not-a-real-token"],
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

test("Compose network gate accepts only implicit or explicit private default for every reviewed service", () => {
  const baseline = composeConfig();
  assert.equal(inspectComposeConfig(baseline).status, "passed");
  // Real docker compose config --format=json includes ipam:{} by default.
  const serializer = composeConfig();
  serializer.networks.default.ipam = {};
  assert.equal(inspectComposeConfig(serializer).status, "passed");
  const implicit = composeConfig();
  for (const svc of Object.values(implicit.services)) delete svc.networks;
  assert.equal(inspectComposeConfig(implicit).status, "passed");
  const arrays = composeConfig();
  for (const svc of Object.values(arrays.services)) svc.networks = ["default"];
  assert.equal(inspectComposeConfig(arrays).status, "passed");
  const empty = composeConfig();
  for (const svc of Object.values(empty.services)) svc.networks = { default: {} };
  assert.equal(inspectComposeConfig(empty).status, "passed");
  const noTunnel = composeConfig();
  delete noTunnel.services.cloudflared;
  assert.equal(inspectComposeConfig(noTunnel).status, "passed");
});

test("Compose network gate denies external/renamed/extra networks even without network_mode", () => {
  const mutations = [
    c => { c.networks.debug = { name: "shared_debug", external: true }; },
    c => { c.networks.default.external = true; },
    c => { c.networks.default.external = "false"; },
    c => { c.networks.default.name = "unrelated_default"; },
    c => { c.networks.default.driver = "host"; },
    c => { c.networks.default.internal = false; },
    c => { c.networks.default.ipam = { config: [{ subnet: "10.1.0.0/16" }] }; },
    c => { c.networks.default.ipam = { driver: "custom" }; },
    c => { c.networks.default.ipam = [] ; },
    c => { c.name = "../runner"; },
    c => { c.name = "Runner"; },
    c => { c.networks = null; },
    c => { c.networks = []; },
    c => { c.networks = { debug: { external: true } }; },
  ];
  for (const mutate of mutations) {
    const conf = composeConfig();
    mutate(conf);
    assert.throws(() => inspectComposeConfig(conf), error => {
      assert.match(error.message, /Compose (default )?network/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  }
});

test("Compose network gate denies attachments, aliases and overrides on API, worker and tunnel", () => {
  for (const name of ["runner-api", "runner-worker", "cloudflared"]) {
    for (const joined of [
      { default: null, external: null }, { external: {} }, ["default", "external"],
      ["external"], [], {}, "default", 10, { default: { aliases: ["docker"] } },
      { default: { priority: 100 } }, { default: { ipv4_address: "10.0.0.2" } },
      { default: { link_local_ips: ["169.254.1.1"] } },
    ]) {
      const conf = composeConfig();
      conf.services[name].networks = joined;
      assert.throws(() => inspectComposeConfig(conf),
        /network attachment/, name + " " + JSON.stringify(joined));
    }
  }
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

test("Compose preflight rejects ANY unreviewed sidecar, including privileged rootful Docker proxy", () => {
  for (const [name, svc] of [
    ["debug-proxy", { privileged: true, user: "0:0", ports: [
      { host_ip: "0.0.0.0", target: 2375, published: 2375, protocol: "tcp" }],
      volumes: [{ type: "bind", source: "/var/run/docker.sock",
        target: "/run/docker.sock" }] }],
    ["metrics", { image: "busybox:latest" }],
    ["rootless-looking", service({ ports: [{ host_ip: "0.0.0.0",
      target: 9999, published: 9999, protocol: "tcp" }] })],
  ]) {
    const config = composeConfig();
    config.services[name] = svc;
    assert.throws(() => inspectComposeConfig(config),
      /Unexpected Docker Compose service/, name);
  }
  for (const services of [[], "not-an-object", null]) {
    const config = composeConfig();
    config.services = services;
    assert.throws(() => inspectComposeConfig(config), /Expected runner-api/);
  }
  const withoutTunnel = composeConfig();
  delete withoutTunnel.services.cloudflared;
  assert.equal(inspectComposeConfig(withoutTunnel).status, "passed");
});

test("Compose tunnel may not mount host secrets or join other namespaces", () => {
  const changes = [
    c => { c.services.cloudflared.volumes =
      [{ type: "bind", source: "/etc", target: "/host-secrets" }]; },
    c => { c.services.cloudflared.volumes = ["/srv/credentials:/creds:ro"]; },
    c => { c.services.cloudflared.tmpfs = ["/run"]; },
    c => { c.services.cloudflared.volumes_from = ["runner-worker"]; },
    c => { c.services.cloudflared.devices = ["/dev/kvm"]; },
    c => { c.services.cloudflared.network_mode = "service:runner-worker"; },
    c => { c.services.cloudflared.pid = "host"; },
    c => { c.services.cloudflared.ipc = "service:runner-worker"; },
    c => { c.services.cloudflared.expose = ["8787"]; },
  ];
  for (const mutate of changes) {
    const config = composeConfig();
    mutate(config);
    assert.throws(() => inspectComposeConfig(config),
      /cloudflared: unsafe/, "unexpected tunnel host access");
  }
  const harmless = composeConfig();
  harmless.services.cloudflared.volumes = [];
  harmless.services.cloudflared.tmpfs = [];
  assert.equal(inspectComposeConfig(harmless).tunnelServiceChecked, true);
});

test("Compose fail-closes for namespace sharing even without host networking", () => {
  for (const name of ["runner-api", "runner-worker", "cloudflared"]) {
    for (const [field, value] of [
      ["network_mode", "service:runner-worker"],
      ["network_mode", "container:abcdef123456"],
      ["network_mode", "host"],
      ["network_mode", "bridge"],
      ["pid", "service:runner-worker"],
      ["pid", "container:abcdef123456"],
      ["pid", "host"],
      ["ipc", "service:runner-worker"],
      ["ipc", "host"],
      ["uts", "host"],
      ["userns_mode", "host"],
      ["cgroup", "host"],
      ["cgroupns_mode", "host"],
      ["isolation", "default"],
    ]) {
      const config = composeConfig();
      config.services[name][field] = value;
      assert.throws(() => inspectComposeConfig(config),
        /unsafe|networking forbidden/, name + "." + field + "=" + value);
    }
  }
  const noTunnel = composeConfig();
  delete noTunnel.services.cloudflared;
  assert.equal(inspectComposeConfig(noTunnel).status, "passed");
});

test("Compose requires exact no-new-privileges and cap-drop profiles, without security overrides", () => {
  const originalProfile = ["no-new-privileges:true"];
  for (const serviceName of ["runner-api", "runner-worker", "cloudflared"]) {
    for (const [field, value] of [
      ["security_opt", ["no-new-privileges:true", "seccomp=unconfined"]],
      ["security_opt", ["no-new-privileges:true", "apparmor=unconfined"]],
      ["security_opt", ["no-new-privileges:true", "label=disable"]],
      ["security_opt", ["no-new-privileges:false", "no-new-privileges:true"]],
      ["security_opt", ["no-new-privileges:true", "no-new-privileges:true"]],
      ["security_opt", []],
      ["security_opt", "no-new-privileges:true"],
      ["cap_drop", ["ALL", "NET_ADMIN"]],
      ["cap_drop", ["CHOWN"]],
      ["cap_drop", ["ALL", "ALL"]],
      ["cap_drop", "ALL"],
      ["privileged", "false"],
      ["privileged", "true"],
      ["privileged", true],
      ["device_cgroup_rules", ["a *:* rwm"]],
      ["device_requests", [{ capabilities: [["gpu"]] }]],
      ["gpus", "all"],
      ["group_add", ["docker"]],
      ["sysctls", { "kernel.unprivileged_userns_clone": "1" }],
      ["expose", ["5432"]],
    ]) {
      const config = composeConfig();
      config.services[serviceName][field] = value;
      assert.throws(() => inspectComposeConfig(config),
        /unsafe|mount/, serviceName + "." + field);
    }
    const approved = composeConfig();
    approved.services[serviceName].security_opt = [...originalProfile];
    approved.services[serviceName].cap_drop = ["ALL"];
    assert.equal(inspectComposeConfig(approved).status, "passed");
  }
});

test("Compose rejects inherited/implicit mounts that could hand the API the worker socket", () => {
  for (const service of ["runner-api", "runner-worker", "cloudflared"]) {
    for (const [field, value] of [
      ["volumes_from", ["runner-worker"]],
      ["secrets", [{ source: "runner_api_key", target: "/run/secrets/key" }]],
      ["configs", [{ source: "runner_debug", target: "/etc/debug" }]],
      ["tmpfs", ["/run"]],
      ["devices", ["/dev/kvm"]],
      ["volumes_from", { hidden: "runner-worker" }],
    ]) {
      const config = composeConfig();
      config.services[service][field] = value;
      assert.throws(() => inspectComposeConfig(config),
        /unsafe|mount/, service + "." + field + " must not bypass volumes gate");
    }
  }
  const safe = composeConfig();
  assert.equal(inspectComposeConfig(safe).status, "passed");
});

test("Compose runner source mounts are canonical, non-system and disjoint", () => {
  const cases = [
    c => { c.services["runner-api"].volumes[0].source = "/"; },
    c => { c.services["runner-api"].volumes[0].source = "/etc/ssh"; },
    c => { c.services["runner-api"].volumes[0].source = "/proc/self"; },
    c => { c.services["runner-worker"].volumes[1].source = "/srv/softwarefactory/workspaces/../other"; },
    c => { c.services["runner-worker"].volumes[1].source = "/root/private"; },
    c => { c.services["runner-worker"].environment.RUNNER_HOST_WORK_DIR =
      c.services["runner-api"].volumes[0].source + "/work"; },
    c => { c.services["runner-worker"].volumes[1].source =
      c.services["runner-api"].volumes[0].source + "/work";
      c.services["runner-worker"].environment.RUNNER_HOST_WORK_DIR =
        c.services["runner-worker"].volumes[1].source; },
    c => { c.services["runner-api"].volumes[0].source =
      c.services["runner-worker"].volumes[1].source + "/data"; },
  ];
  for (const mutate of cases) {
    const config = composeConfig();
    mutate(config);
    assert.throws(() => inspectComposeConfig(config),
      /unsafe|distinct|mount/, "unsafe runner host data/work mounts");
  }
  const safe = composeConfig();
  assert.equal(inspectComposeConfig(safe).dockerSocketInWorkerOnly, true);
});

test("Compose binds each socket-capable runner to its reviewed build context and Dockerfile", () => {
  const approved = composeConfig();
  assert.equal(inspectComposeConfig(approved).status, "passed");
  for (const service of ["runner-api", "runner-worker"]) {
    for (const mutate of [
      c => { delete c.services[service].build; },
      c => { c.services[service].build = { context: "https://attacker.invalid/context" }; },
      c => { c.services[service].build.context = "/tmp/untrusted-build"; },
      c => { c.services[service].build.context = checkoutRoot + "/other"; },
      c => { c.services[service].build.dockerfile = "../../unsafe.Dockerfile"; },
      c => { c.services[service].build.dockerfile_inline = "FROM busybox"; },
      c => { c.services[service].build.args = { EVIL: "value" }; },
      c => { c.services[service].build.secrets = ["private-key"]; },
      c => { c.services[service].build.ssh = ["default"]; },
      c => { c.services[service].build.network = "host"; },
      c => { c.services[service].build.target = "debug"; },
      c => { c.services[service].build.additional_contexts = { host: "/etc" }; },
      c => { c.services[service].build.entitlements = ["network.host"]; },
      c => { c.services[service].build = "../remote-build"; },
      c => { c.services[service].image = "attacker/runner:latest"; },
      c => { c.services[service].entrypoint = ["/bin/sh", "-c", "docker ps"]; },
      c => { c.services[service].command = "node hostile-worker.mjs"; },
      c => { c.services[service].healthcheck = {
        test: ["CMD-SHELL", "docker run -v /:/host busybox"] }; },
      c => { c.services[service].post_start = [{ command: "/bin/sh -c evil" }]; },
      c => { c.services[service].pre_stop = [{ command: "/bin/sh -c evil" }]; },
      c => { c.services[service].develop = { watch: [{
        path: "/etc", action: "sync", target: "/app" }] }; },
      c => { c.services[service].pull_policy = "always"; },
    ]) {
      const config = composeConfig();
      mutate(config);
      assert.throws(() => inspectComposeConfig(config),
        /unapproved image, build or executable override/, service);
    }
  }
});

test("Compose blocks NODE_OPTIONS, LD_PRELOAD and unexpected env for API and socket-owning worker", () => {
  for (const service of ["runner-api", "runner-worker"]) {
    for (const [key, value] of [
      ["NODE_OPTIONS", "--import=/data/hostile.mjs"],
      ["NODE_PATH", "/data/evil"],
      ["LD_PRELOAD", "/data/intercept.so"],
      ["DOCKER_CONFIG", "/tmp/hostile"],
      ["NPM_CONFIG_SCRIPT_SHELL", "/bin/sh"],
      ["BASH_ENV", "/data/hostile"],
      ["PATH", "/data/bin"],
      ["UNREVIEWED_RUNTIME_TOGGLE", "true"],
    ]) {
      const config = composeConfig();
      config.services[service].environment[key] = value;
      assert.throws(() => inspectComposeConfig(config),
        /unapproved runtime environment override/, service + " " + key);
    }
    for (const override of ["/tmp", "/mnt/other", "", null]) {
      const config = composeConfig();
      config.services[service].environment.RUNNER_DATA_DIR = override;
      assert.throws(() => inspectComposeConfig(config),
        /unapproved runtime environment override/);
    }
    const config = composeConfig();
    config.services[service].environment = ["NODE_OPTIONS=--import=/data/evil.mjs"];
    assert.throws(() => inspectComposeConfig(config),
      /unapproved runtime environment override/);
  }
  const approved = composeConfig();
  approved.services["runner-api"].environment.RUNNER_API_KEY_FILE = "";
  approved.services["runner-api"].environment.RUNNER_TENANTS_FILE = "";
  approved.services["runner-api"].environment.RUNNER_REPAIR_OPERATORS_JSON = "";
  approved.services["runner-api"].environment.RUNNER_MAX_QUEUED = "4";
  assert.equal(inspectComposeConfig(approved).status, "passed");
});

test("Compose tunnel cannot be replaced by another image, startup hook or local build", () => {
  for (const mutate of [
    c => { c.services.cloudflared.image = "attacker/cloudflared:latest"; },
    c => { delete c.services.cloudflared.image; },
    c => { c.services.cloudflared.build = { context: checkoutRoot,
      dockerfile: "docker/runner/Dockerfile.worker" }; },
    c => { c.services.cloudflared.entrypoint = ["/bin/sh"]; },
    c => { c.services.cloudflared.post_start = [{ command: "docker ps" }]; },
    c => { c.services.cloudflared.pre_stop = [{ command: "curl https://evil" }]; },
    c => { c.services.cloudflared.healthcheck = { test: ["CMD", "sh"] }; },
    c => { c.services.cloudflared.develop = { watch: ["host"] }; },
  ]) {
    const config = composeConfig();
    mutate(config);
    assert.throws(() => inspectComposeConfig(config),
      /cloudflared: unapproved image, command or runtime override/);
  }
  const noTunnel = composeConfig();
  delete noTunnel.services.cloudflared;
  assert.equal(inspectComposeConfig(noTunnel).status, "passed");
});


test("Compose refuses DNS and host identity injection on all reviewed services", () => {
  const mutations = [
    svc => { svc.extra_hosts = ["runner-api:203.0.113.9"]; },
    svc => { svc.extra_hosts = { "runner-api": "203.0.113.9" }; },
    svc => { svc.links = ["runner-api:trusted"]; },
    svc => { svc.dns = ["203.0.113.53"]; },
    svc => { svc.dns_search = ["attacker.invalid"]; },
    svc => { svc.dns_opt = ["ndots:0"]; },
    svc => { svc.hostname = "runner-api"; },
    svc => { svc.domainname = "attacker.invalid"; },
    svc => { svc.container_name = "trusted-api"; },
    svc => { svc.mac_address = "02:42:ac:11:00:02"; },
    svc => { svc.network_interface_name = "host0"; },
    svc => { svc.extra_hosts = "runner-api:203.0.113.9"; },
  ];
  for (const name of ["runner-api", "runner-worker", "cloudflared"]) {
    for (const mutate of mutations) {
      const config = composeConfig();
      mutate(config.services[name]);
      assert.throws(() => inspectComposeConfig(config), error => {
        assert.match(error.message, /unapproved DNS or host identity override/);
        assert.doesNotMatch(error.message, /203\.0\.113|attacker\.invalid/);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      }, name);
    }
    const neutral = composeConfig();
    neutral.services[name].extra_hosts = [];
    neutral.services[name].links = [];
    neutral.services[name].dns = [];
    assert.equal(inspectComposeConfig(neutral).status, "passed");
  }
});

test("Compose cloudflared argv, user, rootfs and environment are pinned", () => {
  assert.equal(inspectComposeConfig(composeConfig()).tunnelServiceChecked, true);
  const mutations = [
    svc => { svc.user = "0:0"; },
    svc => { delete svc.user; },
    svc => { svc.read_only = false; },
    svc => { delete svc.read_only; },
    svc => { svc.environment = { TUNNEL_ORIGIN_CERT: "/data/cert" }; },
    svc => { svc.environment = ["TUNNEL_TOKEN=untrusted"]; },
    svc => { svc.command = ["tunnel", "run", "--token", "not-a-real-token"]; },
    svc => { svc.command = ["tunnel", "--no-autoupdate", "run", "--url", "http://evil.invalid"]; },
    svc => { svc.command = "tunnel --no-autoupdate run --token not-a-real-token"; },
    svc => { svc.command = ["tunnel", "--no-autoupdate", "run", "--token", ""]; },
    svc => { svc.command = ["tunnel", "--no-autoupdate", "run", "--token", "--url"]; },
    svc => { svc.command = ["tunnel", "--no-autoupdate", "run", "--token", "bad\nTOKEN"]; },
    svc => { svc.command = ["tunnel", "--no-autoupdate", "run", "--token", "a".repeat(4097)]; },
    svc => { svc.command = ["tunnel", "--no-autoupdate", "run", "--token", "not-a-real-token", "extra"]; },
    svc => { svc.command = null; },
  ];
  for (const mutate of mutations) {
    const config = composeConfig();
    mutate(config.services.cloudflared);
    assert.throws(() => inspectComposeConfig(config), error => {
      assert.match(error.message, /cloudflared: unapproved image, command or runtime override/);
      assert.doesNotMatch(error.message, /evil\.invalid|bad|not-a-real-token/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  }
  const neutral = composeConfig();
  neutral.services.cloudflared.environment = {};
  assert.equal(inspectComposeConfig(neutral).status, "passed");
  const noTunnel = composeConfig();
  delete noTunnel.services.cloudflared;
  assert.equal(inspectComposeConfig(noTunnel).tunnelServiceChecked, false);
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
  }), uid: 1000, runDocker }), /unsafe|symlink/);
});

test("VM host env enforces canonical system-safe and segment-disjoint directories", () => {
  const invalid = [
    ["/srv/softwarefactory/workspaces/cache", "/srv/softwarefactory/workspaces"],
    ["/srv/softwarefactory/workspaces", "/srv/softwarefactory/workspaces/cache"],
    ["/srv/softwarefactory/runner-data", "/srv/softwarefactory/runner-data"],
    ["/srv/softwarefactory/../etc", "/srv/softwarefactory/workspaces"],
    ["/etc/runner-data", "/srv/softwarefactory/workspaces"],
    ["/var/run/workspaces", "/srv/softwarefactory/runner-data"],
    ["/tmp/runner-data", "/srv/softwarefactory/workspaces"],
    ["/srv/softwarefactory/runner-data/", "/srv/softwarefactory/workspaces"],
    ["/srv/softwarefactory/runner-data", "/root/private-workspaces"],
  ];
  for (const [data, work] of invalid) {
    assert.throws(() => validateHostEnvironment({
      ...apiEnv, RUNNER_DATA_DIR: data, RUNNER_HOST_WORK_DIR: work,
    }), /Invalid runner host directory|must be separate/);
  }
  for (const [data, work] of [
    ["/srv/softwarefactory/data", "/srv/softwarefactory/database"],
    ["/var/lib/softwarefactory/data", "/srv/softwarefactory/workspaces"],
  ]) {
    assert.equal(validateHostEnvironment({
      ...apiEnv, RUNNER_DATA_DIR: data, RUNNER_HOST_WORK_DIR: work,
    }), true, "similar prefixes are not ancestor relationships");
  }
});

test("host preflight rejects unsafe directory topology before probing Docker", async () => {
  const called = [];
  const stat = async pathname => {
    const socket = pathname === apiEnv.RUNNER_DOCKER_SOCKET;
    called.push(pathname);
    return { uid: 1000, mode: socket ? 0o140600 : 0o040700,
      isDirectory: () => !socket, isSocket: () => socket,
      isSymbolicLink: () => false };
  };
  let dockerCalls = 0;
  const runDocker = async () => { dockerCalls++; return '["name=rootless"]'; };
  for (const env of [
    { ...apiEnv, RUNNER_DATA_DIR: apiEnv.RUNNER_HOST_WORK_DIR + "/evidence" },
    { ...apiEnv, RUNNER_HOST_WORK_DIR: apiEnv.RUNNER_DATA_DIR + "/build" },
    { ...apiEnv, RUNNER_DATA_DIR: "/etc/runner-secret" },
  ]) {
    await assert.rejects(inspectHost({ env, stat, uid: 1000, runDocker }),
      /Invalid runner host directory|must be separate/);
    assert.equal(dockerCalls, 0);
  }
  for (const symlinkComponent of [
    "/srv/softwarefactory", "/run/user/1000",
  ]) {
    const suspicious = async pathname => ({
      ...await stat(pathname),
      isSymbolicLink: () => pathname === symlinkComponent,
    });
    await assert.rejects(inspectHost({
      env: apiEnv, stat: suspicious, uid: 1000, runDocker,
    }), /symlink/);
    assert.equal(dockerCalls, 0);
  }
  assert.ok(called.includes("/srv/softwarefactory"),
    "each intermediate directory is inspected, not just the leaf");
});

test("host path inspection rejects real intermediate symlinks and malformed paths", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-preflight-path-"));
  try {
    await mkdir(path.join(dir, "real", "private"), { recursive: true, mode: 0o700 });
    await symlink(path.join(dir, "real"), path.join(dir, "alias"));
    const safe = await inspectHostPath(path.join(dir, "real", "private"));
    assert.equal(safe.isDirectory(), true);
    await assert.rejects(inspectHostPath(path.join(dir, "alias", "private")),
      /symlink/);
    await assert.rejects(inspectHostPath(dir + "/real/../real"),
      /canonical/);
    await assert.rejects(inspectHostPath(path.join(dir, "missing", "private")),
      /unavailable/);
  } finally { await rm(dir, { recursive: true, force: true }); }
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

test("Access Service Auth probe requires gateway denial, then checks API key and CORS behind Access", async () => {
  const id = "a".repeat(44) + ".access";
  const serviceSecret = "cfast_" + "b".repeat(48);
  const apiKey = "k".repeat(48);
  const origin = "https://factory.example.org";
  const baseUrl = "https://runner.example.org";
  const calls = [];
  const gateway = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "manual");
    assert.notEqual(options.method, "POST");
    assert.equal(new URL(url).origin, baseUrl);
    const route = new URL(url).pathname;
    const protectedRequest = Boolean(options.headers["CF-Access-Client-Id"]);
    if (!protectedRequest) {
      assert.equal(calls.length, 1, "only the negative probe may omit Access");
      assert.deepEqual(options.headers, { Origin: origin });
      return new Response(null, { status: 302, headers: {
        Location: "https://private.cloudflareaccess.com/login?private-do-not-log",
      } });
    }
    assert.equal(options.headers["CF-Access-Client-Id"], id);
    assert.equal(options.headers["CF-Access-Client-Secret"], serviceSecret);
    if (route === "/healthz") return new Response("{}", { status: 200 });
    if (route === "/v1/capabilities" && !options.headers.Authorization)
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    if (route === "/v1/capabilities" && options.headers.Authorization) {
      assert.equal(options.headers.Authorization, "Bearer " + apiKey);
      return new Response(JSON.stringify({ protocol: 1, networkDefault: "none",
        steps: ["dotnet-build", "dotnet-test"] }), { status: 200 });
    }
    if (route === "/v1/jobs" && options.method === "OPTIONS")
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key",
      } });
    throw Error("unexpected gateway route");
  };
  const result = await probeEndpoint({ baseUrl, origin, apiKey,
    accessClientId: id, accessClientSecret: serviceSecret, fetchImpl: gateway });
  assert.deepEqual(result, {
    mode: "endpoint", status: "passed", https: true, bearerAuthRequired: true,
    corsPreflightPassed: true, networkDefaultNone: true,
    accessServiceTokenUsed: true, accessUnauthenticatedDenied: true,
  });
  assert.deepEqual(calls.map(x => x.options.method),
    ["GET", "GET", "GET", "GET", "OPTIONS"]);
  assert.deepEqual(calls.map(x => Boolean(x.options.headers.Authorization)),
    [false, false, false, true, false]);
  assert.ok(calls.slice(1).every(x => x.options.headers["CF-Access-Client-Id"] === id));
  assert.doesNotMatch(JSON.stringify(result), /cfast_|\.access|Bearer|private-do-not-log/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(apiKey));
});

test("Access credentials must be a complete bounded printable pair before any network call", async () => {
  const bad = [
    { accessClientId: "a".repeat(48) },
    { accessClientSecret: "b".repeat(64) },
    { accessClientId: "", accessClientSecret: "b".repeat(64) },
    { accessClientId: "a".repeat(48), accessClientSecret: "" },
    { accessClientId: "a".repeat(48), accessClientSecret: "REPLACE_ME" },
    { accessClientId: "a".repeat(48) + "\r\nInjected: evil",
      accessClientSecret: "b".repeat(64) },
    { accessClientId: "a".repeat(48),
      accessClientSecret: "b".repeat(64) + "\nAuthorization: fake" },
    { accessClientId: "a".repeat(257), accessClientSecret: "b".repeat(64) },
    { accessClientId: "a".repeat(48), accessClientSecret: "b".repeat(513) },
    { accessClientId: "a".repeat(48), accessClientSecret: "secret with spaces".repeat(4) },
  ];
  for (const credentials of bad) {
    let requestCount = 0;
    await assert.rejects(probeEndpoint({
      baseUrl: "https://runner.example.org", origin: "https://factory.example.org",
      apiKey: secret, ...credentials,
      fetchImpl: async () => { requestCount++; throw Error("must not connect"); },
    }), error => error.message ===
      "Cloudflare Access service credentials missing or invalid");
    assert.equal(requestCount, 0);
  }
});

test("Access endpoint must deny requests without its service token and reject expired or redirected Access", async () => {
  const credentials = { accessClientId: "a".repeat(44) + ".access",
    accessClientSecret: "b".repeat(64) };
  const common = { baseUrl: "https://runner.example.org",
    origin: "https://factory.example.org", apiKey: secret, ...credentials };
  for (const denial of [200, 204, 404, 500]) {
    let count = 0;
    await assert.rejects(probeEndpoint({ ...common,
      fetchImpl: async () => { count++; return new Response(null, { status: denial }); },
    }), /not restricted/);
    assert.equal(count, 1);
  }
  for (const authenticatedStatus of [302, 401, 403]) {
    let count = 0;
    await assert.rejects(probeEndpoint({ ...common,
      fetchImpl: async () => {
        return ++count === 1 ? new Response(null, { status: 403 }) :
          new Response(null, { status: authenticatedStatus });
      },
    }), error => !error.message.includes(credentials.accessClientSecret) &&
      !error.message.includes(credentials.accessClientId) &&
      /liveness|redirected/.test(error.message));
    assert.equal(count, 2);
  }
  await assert.rejects(probeEndpoint({ ...common,
    fetchImpl: async (url, options) => {
      if (!options.headers["CF-Access-Client-Id"])
        return new Response(null, { status: 403 });
      throw Error("CF-Access-Client-Secret=" + credentials.accessClientSecret);
    },
  }), error => error.message === "HTTPS endpoint request failed or redirected");
});

test("preflight endpoint CLI forwards optional service token only from a 0600 private env file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-access-preflight-"));
  const file = path.join(dir, "runner.env");
  const clientId = "c".repeat(48), clientSecret = "d".repeat(64);
  const records = [];
  try {
    await writeFile(file, [
      "RUNNER_API_KEY=" + secret,
      "CF_ACCESS_CLIENT_ID=" + clientId,
      "CF_ACCESS_CLIENT_SECRET=" + clientSecret,
    ].join("\n"), { mode: 0o600 });
    const status = await main([
      "endpoint", "--env-file=" + file,
      "--url=https://runner.example.org", "--origin=https://factory.example.org",
    ], {
      endpointProbe: async input => {
        assert.equal(input.apiKey, secret);
        assert.equal(input.accessClientId, clientId);
        assert.equal(input.accessClientSecret, clientSecret);
        return { mode: "endpoint", status: "passed",
          accessServiceTokenUsed: true, accessUnauthenticatedDenied: true };
      },
      write: line => records.push(line),
    });
    assert.equal(status.status, "passed");
    assert.equal(records.length, 1);
    assert.doesNotMatch(records[0], new RegExp(secret));
    assert.doesNotMatch(records[0], new RegExp(clientSecret));
    assert.doesNotMatch(records[0], new RegExp(clientId));
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("host profile selection is exclusive and secret paths are segment-disjoint", () => {
  const base = { ...apiEnv, RUNNER_API_KEY: "", RUNNER_API_KEY_FILE: "",
    RUNNER_TENANTS_FILE: "", RUNNER_API_KEY_DIR: "/srv/softwarefactory/api-key",
    RUNNER_TENANTS_DIR: "/srv/softwarefactory/tenants",
    RUNNER_REPAIR_OPERATORS_DIR: "/srv/softwarefactory/operators",
    RUNNER_REPAIR_OPERATORS_JSON: "" };
  assert.equal(validateHostEnvironment(base, { authMode: "key-file" }), true);
  assert.equal(validateHostEnvironment(base, { authMode: "tenants" }), true);
  assert.equal(validateHostEnvironment(base, {
    authMode: "key-file", operatorRegistry: true }), true);
  for (const [env, options] of [
    [{ ...base, RUNNER_API_KEY: secret }, { authMode: "key-file" }],
    [{ ...base, RUNNER_API_KEY: "REPLACE_ME" }, { authMode: "tenants" }],
    [{ ...base, RUNNER_API_KEY_FILE: "/data/key" }, { authMode: "key-file" }],
    [{ ...base, RUNNER_TENANTS_FILE: "/data/tenants" }, { authMode: "tenants" }],
    [{ ...base, RUNNER_REPAIR_OPERATORS_FILE: "/run/secrets/runner-operators/operators.json" },
      { authMode: "key-file", operatorRegistry: true }],
    [{ ...base, RUNNER_REPAIR_OPERATORS_JSON: "[]" },
      { authMode: "key-file", operatorRegistry: true }],
    [{ ...base, RUNNER_REPAIR_OPERATORS_JSON: "[]" },
      { authMode: "tenants" }],
    [{ ...base, RUNNER_API_KEY_DIR: base.RUNNER_DATA_DIR + "/api-key" },
      { authMode: "key-file" }],
    [{ ...base, RUNNER_TENANTS_DIR: base.RUNNER_HOST_WORK_DIR },
      { authMode: "tenants" }],
    [{ ...base, RUNNER_REPAIR_OPERATORS_DIR: base.RUNNER_API_KEY_DIR + "/operators" },
      { authMode: "key-file", operatorRegistry: true }],
    [{ ...base, RUNNER_TENANTS_DIR: "/etc/tenants" }, { authMode: "tenants" }],
    [base, { authMode: "tenants", operatorRegistry: true }],
    [base, { authMode: "other" }],
    [base, { authMode: "inline" }],
  ]) assert.throws(() => validateHostEnvironment(env, options),
    /credential|key|private|directory|separate|operators/i);
});

test("host profile verifies UID 1000 directory, private file and rootless probe", async () => {
  const base = { ...apiEnv, RUNNER_API_KEY: "", RUNNER_API_KEY_FILE: "",
    RUNNER_TENANTS_FILE: "", RUNNER_API_KEY_DIR: "/srv/softwarefactory/api-key",
    RUNNER_TENANTS_DIR: "/srv/softwarefactory/tenants",
    RUNNER_REPAIR_OPERATORS_DIR: "/srv/softwarefactory/operators",
    RUNNER_REPAIR_OPERATORS_JSON: "" };
  const filenames = [];
  const stat = async name => ({ uid: 1000, mode: name.endsWith("docker.sock") ?
    0o140600 : 0o040700, isDirectory: () => !name.endsWith("docker.sock"),
    isSocket: () => name.endsWith("docker.sock"), isSymbolicLink: () => false });
  const fakeDocker = async () => JSON.stringify(["name=rootless"]);
  const readCredential = async (name, kind) => {
    filenames.push([name, kind]);
    return kind === "key" ? secret : kind === "tenants" ? true :
      JSON.stringify([{ id: "alice", key: "o".repeat(48), roles: ["review"] }]);
  };
  const key = await inspectHost({ env: base, stat, uid: 1000,
    authMode: "key-file", operatorRegistry: true,
    readCredential, runDocker: fakeDocker });
  assert.equal(key.credentialMode, "key-file");
  assert.equal(key.credentialsPrivate, true);
  assert.deepEqual(filenames, [
    ["/srv/softwarefactory/api-key/runner-key", "key"],
    ["/srv/softwarefactory/operators/operators.json", "operators"] ]);
  filenames.length = 0;
  const tenant = await inspectHost({ env: base, stat, uid: 1000,
    authMode: "tenants", readCredential, runDocker: fakeDocker });
  assert.equal(tenant.credentialMode, "tenants");
  assert.deepEqual(filenames, [
    ["/srv/softwarefactory/tenants/tenants.json", "tenants"] ]);
  const failRead = async () => { throw Error("private simulated secret"); };
  await assert.rejects(inspectHost({ env: base, stat, uid: 1000,
    authMode: "tenants", readCredential: failRead, runDocker: fakeDocker }),
    error => error.message === "Runner host private credential file unavailable or unsafe");
  const symlink = async name => ({ ...await stat(name),
    isSymbolicLink: () => name === "/srv/softwarefactory/tenants" });
  let checkedDocker = false;
  await assert.rejects(inspectHost({ env: base, stat: symlink, uid: 1000,
    authMode: "tenants", readCredential, runDocker: async () => {
      checkedDocker = true; return '["name=rootless"]'; } }), /symlink/);
  assert.equal(checkedDocker, false);
});


test("host CLI forwards explicit file and operator selections without showing secrets", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-host-flags-"));
  const file = path.join(dir, "config.env");
  const seen = [];
  try {
    await writeFile(file, "RUNNER_API_KEY=\nRUNNER_API_KEY_DIR=/srv/softwarefactory/key",
      { mode: 0o600 });
    await main(["host", "--runner-key-file", "--operator-registry",
      "--env-file=" + file], {
      hostProbe: async input => {
        assert.equal(input.authMode, "key-file");
        assert.equal(input.operatorRegistry, true);
        assert.equal(input.env.RUNNER_API_KEY, "");
        return { mode: "host", status: "passed" };
      }, write: line => seen.push(line),
    });
    assert.equal(seen.length, 1);
    assert.doesNotMatch(seen[0], /RUNNER_API_KEY|softwarefactory\/key/);
    await assert.rejects(main(["host", "--tenants", "--operator-registry",
      "--env-file=" + file], {
      hostProbe: async () => { assert.fail("invalid combination must not probe"); },
    }), /Invalid flags/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real private host credential reader pins inode, rejects links, and sees atomic rotation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-host-auth-"));
  const uid = process.geteuid();
  const file = path.join(dir, "runner-key");
  const token1 = "a".repeat(48), token2 = "b".repeat(48);
  const tenants = path.join(dir, "tenants.json");
  try {
    await writeFile(file, token1 + "\n", { mode: 0o600 });
    assert.equal(await readHostCredential(file, "key", { uid }), token1);
    await writeFile(path.join(dir, "runner-key.new"), token2, { mode: 0o600 });
    const { rename } = await import("node:fs/promises");
    await rename(path.join(dir, "runner-key.new"), file);
    assert.equal(await readHostCredential(file, "key", { uid }), token2);
    await chmod(file, 0o644);
    await assert.rejects(readHostCredential(file, "key", { uid }), /private credential/);
    await chmod(file, 0o600);
    await symlink(file, path.join(dir, "linked"));
    await assert.rejects(readHostCredential(path.join(dir, "linked"), "key", { uid }),
      /private credential/);
    await link(file, path.join(dir, "hardlink"));
    await assert.rejects(readHostCredential(file, "key", { uid }), /private credential/);
    await rm(path.join(dir, "hardlink"));
    await writeFile(tenants, JSON.stringify({ version: 1, tenants: [{
      id: "alpha", key: "alpha." + "x".repeat(48),
      maxQueued: 2, maxRetained: 5, maxAcceptedPerMinute: 0,
    }] }), { mode: 0o600 });
    assert.equal(await readHostCredential(tenants, "tenants", { uid }), true);
    await writeFile(tenants, JSON.stringify({ version: 1, tenants: [] }));
    await assert.rejects(readHostCredential(tenants, "tenants", { uid }),
      /private credential/);
    await writeFile(tenants, "{}", { mode: 0o600 });
    await assert.rejects(readHostCredential(tenants, "tenants", { uid }),
      /private credential/);
    await writeFile(path.join(dir, "operators.json"),
      JSON.stringify([{ id: "alice", key: "c".repeat(48),
        roles: ["review"] }]), { mode: 0o600 });
    assert.match(await readHostCredential(path.join(dir, "operators.json"),
      "operators", { uid }), /alice/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("off-host endpoint profile uses only private explicitly supplied probe bearer", () => {
  const tenantBearer = "alpha." + "q".repeat(48);
  const keyBearer = "z".repeat(48);
  for (const [mode, bearer] of [
    ["tenants", tenantBearer], ["key-file", keyBearer],
  ]) {
    const env = { RUNNER_API_KEY: "", RUNNER_PROBE_BEARER: bearer };
    assert.equal(selectEndpointBearer(env, {
      authMode: mode, privateEnv: true }), bearer);
    for (const bad of [
      { ...env, RUNNER_API_KEY: secret },
      { ...env, RUNNER_PROBE_BEARER: "" },
      { ...env, RUNNER_PROBE_BEARER: "REPLACE_ME" },
      { ...env, RUNNER_PROBE_BEARER: "evil\nHeader: fake" },
      { ...env, RUNNER_API_KEY_FILE: "/data/key" },
    ]) assert.throws(() => selectEndpointBearer(bad,
      { authMode: mode, privateEnv: true }), /probe|container credential/);
    assert.throws(() => selectEndpointBearer(env, { authMode: mode }),
      /probe bearer/);
  }
  assert.throws(() => selectEndpointBearer({
    RUNNER_API_KEY: "", RUNNER_PROBE_BEARER: keyBearer,
  }, { authMode: "tenants", privateEnv: true }), /probe bearer/);
  assert.throws(() => selectEndpointBearer({
    RUNNER_API_KEY: secret, RUNNER_PROBE_BEARER: keyBearer,
  }), /alternate bearer/);
  assert.equal(selectEndpointBearer({ RUNNER_API_KEY: secret }), secret);
});

test("endpoint CLI selects private tenant bearer without reading any registry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-probe-auth-"));
  const file = path.join(dir, "probe.env");
  const bearer = "alpha." + "r".repeat(48);
  const sent = [];
  try {
    await writeFile(file, "RUNNER_API_KEY=\nRUNNER_PROBE_BEARER=" + bearer,
      { mode: 0o600 });
    const result = await main(["endpoint", "--tenants", "--env-file=" + file,
      "--url=https://runner.example.org", "--origin=https://factory.example.org"],
    { endpointProbe: async options => {
      assert.equal(options.apiKey, bearer);
      return { mode: "endpoint", status: "passed" };
    }, write: s => sent.push(s) });
    assert.equal(result.status, "passed");
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0], /alpha\.|RUNNER_PROBE_BEARER/);
    await assert.rejects(main(["endpoint", "--tenants",
      "--url=https://runner.example.org", "--origin=https://factory.example.org"],
    { endpointProbe: async () => { assert.fail("must not probe"); } }),
    /probe bearer/);
  } finally { await rm(dir, { recursive: true, force: true }); }
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



test("Compose accepts neutral Compose v2 bind serializer fields but rejects unreviewed bind options", () => {
  const neutral = composeConfig();
  neutral.services["runner-api"].volumes[0].bind = { create_host_path: true };
  neutral.services["runner-worker"].volumes[0].bind = {};
  neutral.services["runner-worker"].volumes[1].bind = { create_host_path: false };
  neutral.services["runner-worker"].volumes[2].bind = { create_host_path: true };
  assert.equal(inspectComposeConfig(neutral).status, "passed");

  const mutations = [
    v => { v.bind = { propagation: "rshared" }; },
    v => { v.bind = { create_host_path: true, propagation: "shared" }; },
    v => { v.bind = { selinux: "z" }; },
    v => { v.bind = { create_host_path: "true" }; },
    v => { v.bind = { create_host_path: null }; },
    v => { v.bind = ["create_host_path"]; },
    v => { v.bind = "rw"; },
    v => { v.consistency = "cached"; },
    v => { v.volume = { nocopy: false }; },
    v => { v.tmpfs = { size: 1024 }; },
    v => { v.read_only = "false"; },
    v => { v.read_only = {}; },
    v => { v.unreviewed = true; },
  ];
  for (const name of ["runner-api", "runner-worker"]) {
    const size = composeConfig().services[name].volumes.length;
    for (let index = 0; index < size; index++) {
      for (const mutate of mutations) {
        const c = composeConfig();
        mutate(c.services[name].volumes[index]);
        assert.throws(() => inspectComposeConfig(c), error => {
          assert.match(error.message, /unsafe bind mounts/);
          assert.doesNotMatch(error.message, new RegExp(secret));
          return true;
        }, name + " mount " + index);
      }
    }
  }
  for (const name of ["runner-api", "runner-worker"]) {
    const c = composeConfig();
    c.services[name].volumes[0].read_only = true;
    assert.throws(() => inspectComposeConfig(c), /runner-api: unexpected mounts|runner-worker: expected/);
  }
});

test("operator-only registry cannot live inside or above runner data or worker workspace", () => {
  const valid = composeConfig();
  valid.services["runner-api"].volumes.push({
    type: "bind", source: "/srv/softwarefactory/private-operators",
    target: "/run/secrets/runner-operators", read_only: true,
    bind: { create_host_path: false },
  });
  valid.services["runner-api"].environment.RUNNER_REPAIR_OPERATORS_FILE =
    "/run/secrets/runner-operators/operators.json";
  valid.services["runner-api"].environment.RUNNER_REPAIR_OPERATORS_JSON = "";
  assert.equal(inspectComposeConfig(valid).status, "passed");

  for (const source of [
    apiEnv.RUNNER_DATA_DIR,
    apiEnv.RUNNER_DATA_DIR + "/secrets",
    apiEnv.RUNNER_HOST_WORK_DIR,
    apiEnv.RUNNER_HOST_WORK_DIR + "/operators",
    "/srv/softwarefactory",
  ]) {
    const c = structuredClone(valid);
    c.services["runner-api"].volumes[1].source = source;
    assert.throws(() => inspectComposeConfig(c), error => {
      assert.match(error.message, /runner-api: (unsafe private credential|missing or unexpected private credential|ambiguous or unsupported credential)/);
      assert.doesNotMatch(error.message, /s{48}/);
      assert.doesNotMatch(error.message, /\/srv\/softwarefactory/);
      return true;
    }, source);
  }
  const writable = structuredClone(valid);
  writable.services["runner-api"].volumes[1].read_only = false;
  assert.throws(() => inspectComposeConfig(writable), /unsafe private credential/);
});


function withCredentialMount(conf, target, source) {
  conf.services["runner-api"].volumes.push({
    type: "bind", target, source, read_only: true,
    bind: { create_host_path: false },
  });
  return conf;
}
function authCompose(mode) {
  const conf = composeConfig();
  const api = conf.services["runner-api"];
  if (mode === "key-file" || mode === "key-file-operators") {
    api.environment.RUNNER_API_KEY = "";
    api.environment.RUNNER_API_KEY_FILE = "/run/secrets/runner-api/runner-key";
    withCredentialMount(conf, "/run/secrets/runner-api",
      "/srv/softwarefactory/runner-api-key");
  }
  if (mode === "tenants") {
    api.environment.RUNNER_API_KEY = "";
    api.environment.RUNNER_API_KEY_FILE = "";
    api.environment.RUNNER_TENANTS_FILE =
      "/run/secrets/runner-tenants/tenants.json";
    api.environment.RUNNER_REPAIR_OPERATORS_JSON = "";
    withCredentialMount(conf, "/run/secrets/runner-tenants",
      "/srv/softwarefactory/tenant-registry");
  }
  if (mode === "inline-operators" || mode === "key-file-operators") {
    api.environment.RUNNER_REPAIR_OPERATORS_JSON = "";
    api.environment.RUNNER_REPAIR_OPERATORS_FILE =
      "/run/secrets/runner-operators/operators.json";
    withCredentialMount(conf, "/run/secrets/runner-operators",
      "/srv/softwarefactory/repair-operators");
  }
  return conf;
}

test("Compose accepts the supported exclusive inline, file and tenant credentials", () => {
  for (const mode of ["inline", "inline-operators", "key-file",
                      "key-file-operators", "tenants"]) {
    const result = inspectComposeConfig(authCompose(mode));
    assert.equal(result.status, "passed", mode);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
});

test("Compose credential mounts must be private, disjoint, read-only and env-bound", () => {
  for (const mode of ["inline-operators", "key-file",
                      "key-file-operators", "tenants"]) {
    const valid = authCompose(mode);
    const api = valid.services["runner-api"];
    const last = api.volumes.length - 1;
    for (let i = 1; i <= last; i++) {
      const source = api.volumes[i].source;
      const mutations = [
        c => { c.services["runner-api"].volumes[i].read_only = false; },
        c => { delete c.services["runner-api"].volumes[i].read_only; },
        c => { c.services["runner-api"].volumes[i].source = apiEnv.RUNNER_DATA_DIR; },
        c => { c.services["runner-api"].volumes[i].source = apiEnv.RUNNER_HOST_WORK_DIR; },
        c => { c.services["runner-api"].volumes[i].source = "/srv/softwarefactory"; },
        c => { c.services["runner-api"].volumes[i].source = apiEnv.RUNNER_DATA_DIR + "/keys"; },
        c => { c.services["runner-api"].volumes[i].source = apiEnv.RUNNER_HOST_WORK_DIR + "/keys"; },
        c => { c.services["runner-api"].volumes[i].source = "/etc/secret"; },
        c => { c.services["runner-api"].volumes[i].source = source + "/../keys"; },
        c => { c.services["runner-api"].volumes[i].target = "/run/secrets/unknown"; },
        c => { c.services["runner-api"].volumes[i].bind = { propagation: "rshared" }; },
        c => { c.services["runner-api"].volumes.splice(i, 1); },
        c => { c.services["runner-worker"].volumes.push(
          structuredClone(c.services["runner-api"].volumes[i])); },
      ];
      for (const change of mutations) {
        const c = structuredClone(valid);
        change(c);
        assert.throws(() => inspectComposeConfig(c), error => {
          assert.match(error.message, /credential|mount|runner-worker/);
          assert.doesNotMatch(error.message, /\/srv\/softwarefactory/);
          assert.doesNotMatch(error.message, new RegExp(secret));
          return true;
        }, mode + " secret " + i);
      }
    }
  }
  const shared = authCompose("key-file-operators");
  shared.services["runner-api"].volumes[2].source =
    shared.services["runner-api"].volumes[1].source;
  assert.throws(() => inspectComposeConfig(shared), /unsafe private credential/);
  const nested = authCompose("key-file-operators");
  nested.services["runner-api"].volumes[2].source =
    nested.services["runner-api"].volumes[1].source + "/operators";
  assert.throws(() => inspectComposeConfig(nested), /unsafe private credential/);
});

test("Compose denies mismatched, combined or missing auth source and rogue mounts", () => {
  const mutations = [
    c => { c.services["runner-api"].environment.RUNNER_API_KEY = ""; },
    c => { c.services["runner-api"].environment.RUNNER_API_KEY = "short"; },
    c => { c.services["runner-api"].environment.RUNNER_API_KEY_FILE =
      "/run/secrets/runner-api/runner-key"; },
    c => { c.services["runner-api"].environment.RUNNER_TENANTS_FILE =
      "/run/secrets/runner-tenants/tenants.json"; },
    c => { c.services["runner-api"].volumes.push({
      type: "bind", source: "/srv/softwarefactory/rogue",
      target: "/run/secrets/runner-api", read_only: true }); },
  ];
  for (const change of mutations) {
    const c = composeConfig();
    change(c);
    assert.throws(() => inspectComposeConfig(c), /credential|mount/);
  }
  for (const [mode, change] of [
    ["key-file", c => { c.services["runner-api"].environment.RUNNER_API_KEY = secret; }],
    ["key-file", c => { c.services["runner-api"].environment.RUNNER_API_KEY_FILE = "/data/key"; }],
    ["key-file", c => { c.services["runner-api"].environment.RUNNER_TENANTS_FILE = "/data/tenants"; }],
    ["key-file", c => { c.services["runner-api"].environment.RUNNER_REPAIR_OPERATORS_JSON = "[]"; }],
    ["key-file", c => { c.services["runner-api"].environment.RUNNER_API_KEY_FILE = null; }],
    ["tenants", c => { c.services["runner-api"].environment.RUNNER_API_KEY = secret; }],
    ["tenants", c => { c.services["runner-api"].environment.RUNNER_API_KEY_FILE = "/data/key"; }],
    ["tenants", c => { c.services["runner-api"].environment.RUNNER_REPAIR_OPERATORS_JSON = "[]"; }],
    ["tenants", c => { c.services["runner-api"].environment.RUNNER_REPAIR_OPERATORS_FILE =
      "/run/secrets/runner-operators/operators.json"; }],
    ["tenants", c => { c.services["runner-api"].environment.RUNNER_TENANTS_FILE = "/data/tenants"; }],
    ["inline-operators", c => { c.services["runner-api"].environment.RUNNER_REPAIR_OPERATORS_FILE = "/data/secret"; }],
    ["key-file-operators", c => { c.services["runner-api"].volumes[2].target = "/run/secrets/runner-api"; }],
    ["key-file-operators", c => { c.services["runner-api"].volumes[2].source = "/srv/softwarefactory/runner-api-key/ops"; }],
  ]) {
    const c = authCompose(mode);
    change(c);
    assert.throws(() => inspectComposeConfig(c), /credential|mount/, mode);
  }
});

test("preflight mode flags reject conflicting credential profiles before Docker invocation", async () => {
  for (const args of [
    ["compose", "--tenants", "--runner-key-file"],
    ["compose", "--tenants", "--operator-registry"],
    ["compose", "--tenants", "--tenants"],
    ["compose", "--runner-key-file", "--runner-key-file"],
    ["compose", "--runner-key-file=true"],
    ["host", "--runner-key-file"],
    ["host", "--tenants"],
    ["endpoint", "--operator-registry",
      "--url=https://runner.example.org", "--origin=https://factory.example.org"],
  ]) {
    await assert.rejects(main(args, { write: () => {
      assert.fail("invalid flags must not produce success");
    } }), /Invalid flags|Usage:/);
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
