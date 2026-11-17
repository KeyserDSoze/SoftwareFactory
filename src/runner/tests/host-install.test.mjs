import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { main, runHostInstall, probeInstalledRunner,
  verifyCleanPinnedMain } from "../scripts/host-install.mjs";

const SHA = "a".repeat(40);
const IMAGE = "node@sha256:" + "b".repeat(64);
const envFile = "/srv/softwarefactory/private/runner.env";
const apiKey = "k".repeat(40);
const nodeUid = 1000;
const environment = {
  RUNNER_API_KEY: apiKey,
  RUNNER_API_KEY_FILE: "",
  RUNNER_TENANTS_FILE: "",
  RUNNER_ALLOWED_ORIGINS: "https://factory.example",
  RUNNER_DOCKER_SOCKET: "/run/user/1000/docker.sock",
  RUNNER_DATA_DIR: "/srv/softwarefactory/runner-data",
  RUNNER_HOST_WORK_DIR: "/srv/softwarefactory/workspaces",
};
const compose = { mode: "compose", status: "passed", apiLoopbackOnly: true,
  dockerSocketInWorkerOnly: true, tunnelServiceChecked: true };
const host = { mode: "host", status: "passed", uid: 1000,
  directoriesPrivate: true, socketPrivate: true, dockerRootless: true };
const receipt = (id, mode = "inline", operators = false) => ({
  version: 1, scope: "local-vm", status: "passed", authMode: mode,
  operatorRegistry: operators, canaryId: id,
  checks: ["compose", "host", "canary"], dockerRootless: true,
  canaryCleanup: "verified",
});

const ident = {
  "runner-api": "a".repeat(64),
  "runner-worker": "b".repeat(64),
};
function fixture(options = {}) {
  const f = { calls: [], held: false, ps: 0, up: 0, rootless: 0,
    envReads: 0, id: randomUUID(), environment: { ...environment },
    ...options };
  f.args = {
    envFile, commit: SHA, image: IMAGE, mode: "apply", confirmed: true,
    uid: nodeUid, id: f.id, ...options,
    readEnv: async filename => {
      f.envReads++;
      f.calls.push(["read", filename]);
      return { ...f.environment };
    },
    git: async args => {
      f.calls.push(["git", ...args]);
      if (args[0] === "rev-parse") return SHA + "\n";
      if (args[0] === "symbolic-ref") return "main\n";
      if (args[0] === "status") return "";
      assert.fail("Unexpected Git command");
    },
    preflightCheck: async argv => {
      f.calls.push(["preflight", ...argv]);
      if (argv[0] === "compose") return compose;
      return { ...host,
        ...(options.authMode && options.authMode !== "inline" || options.operatorRegistry ?
          { credentialMode: options.authMode || "inline", credentialsPrivate: true,
            operatorRegistryChecked: Boolean(options.operatorRegistry) } : {}) };
    },
    vmAcceptance: async opts => {
      f.calls.push(["canary", opts.authMode, opts.operatorRegistry]);
      return receipt(opts.id, opts.authMode, opts.operatorRegistry);
    },
    probeDocker: async ({host}) => {
      f.rootless++;
      f.calls.push(["rootless", host]);
      return true;
    },
    runDocker: async (argv, callOptions) => {
      f.calls.push(["docker", ...argv]);
      assert.equal(callOptions.env.DOCKER_HOST,
        "unix:///run/user/1000/docker.sock");
      assert.equal(callOptions.env.DOCKER_CONTEXT, undefined);
      assert.equal(callOptions.env.RUNNER_API_KEY, undefined);
      if (argv[0] === "compose") {
        f.up++;
        return "";
      }
      if (argv[0] === "ps") {
        f.ps++;
        return f.ps === 1 ? "" : Object.values(ident).map(s => s.slice(0,12)).join("\n") + "\n";
      }
      if (argv[0] === "inspect") {
        const entry = Object.entries(ident).find(([,id])=>id.startsWith(argv.at(-1)));
        assert.ok(entry);
        return JSON.stringify({
          Id: entry[1], Config: { Labels: {
            "com.docker.compose.service": entry[0],
            "com.docker.compose.project": "sf-runner",
          } }, State: { Running: true, Status: "running" },
          HostConfig: { Privileged: false },
          Mounts: entry[0] === "runner-worker" ? [
            { Type: "bind", Source: "/run/user/1000/docker.sock",
              Destination: "/run/docker.sock" },
          ] : [],
        });
      }
      assert.fail("Unexpected Docker command");
    },
    localReadiness: async ({ bearer }) => {
      f.calls.push(["ready"]);
      assert.equal(bearer, apiKey);
      return true;
    },
    claim: async filename => {
      f.calls.push(["lock", filename]);
      if (f.held) throw Error("EEXIST: concurrent installer");
      f.held = true;
    },
    unclaim: async filename => {
      f.calls.push(["unlock", filename]);
      assert.equal(f.held, true);
      f.held = false;
    },
    writeRecovery: line => {
      assert.match(line, /^ROOTLESS_CANARY_ID=[a-f0-9-]{36}\n$/);
      f.calls.push(["recovery"]);
    },
  };
  return f;
}

test("check is read-only: verifies main/env/Compose/host without canary, Docker or lock", async () => {
  const f = fixture();
  const result = await runHostInstall({
    ...f.args, mode: "check", confirmed: false,
  });
  assert.deepEqual(result, {
    version: 1, state: "ready_to_install", scope: "local-linux",
    commit: SHA, authMode: "inline", operatorRegistry: false,
    checks: ["git", "private-env", "compose", "host"], installed: false,
  });
  assert.equal(f.rootless, 0);
  assert.equal(f.ps, 0);
  assert.equal(f.up, 0);
  assert.ok(!f.calls.some(x=>["lock", "canary", "ready", "docker"].includes(x[0])));
  assert.deepEqual(f.calls.filter(x=>x[0]==="preflight").map(x=>x[1]),
    ["compose","host"]);
});

test("apply requires a verified rootless canary, empty stack and authenticated readiness", async () => {
  const f = fixture();
  const result = await runHostInstall(f.args);
  assert.equal(result.state, "installed");
  assert.equal(result.dockerRootless, true);
  assert.equal(result.commit, SHA);
  assert.equal(result.project, "sf-runner");
  assert.deepEqual(result.services, ["runner-api","runner-worker"]);
  assert.deepEqual(result.checks, ["git", "private-env", "compose", "host",
    "canary", "empty-stack", "compose-up", "container-state",
    "authenticated-readiness"]);
  assert.equal(f.up, 1);
  assert.equal(f.ps, 2);
  assert.equal(f.held, false);
  const actions = f.calls.map(x=>x[0]);
  assert.ok(actions.indexOf("canary") < actions.indexOf("lock"));
  assert.ok(actions.indexOf("lock") < actions.indexOf("docker"));
  assert.ok(actions.indexOf("ready") < actions.indexOf("unlock"));
  const composeArgs = f.calls.find(x=>x[0]==="docker"&&x[1]==="compose");
  assert.deepEqual(composeArgs.slice(-6),
    ["up", "--detach", "--build", "--no-deps", "runner-api", "runner-worker"]);
  assert.ok(!composeArgs.includes("tunnel"));
  assert.ok(!composeArgs.includes("down"));
  assert.ok(!composeArgs.includes("--privileged"));
  assert.ok(!JSON.stringify(result).includes(apiKey));
  assert.ok(!JSON.stringify(result).includes(envFile));
  assert.ok(!JSON.stringify(result).includes(IMAGE));
});

test("file-key and tenant profiles use fixed, reviewed Compose overrides", async () => {
  for (const mode of ["key-file", "tenants"]) {
    const f = fixture({ authMode: mode });
    f.environment.RUNNER_API_KEY = "";
    f.environment.RUNNER_PROBE_BEARER = mode === "tenants"
      ? "tenant-test." + "Z".repeat(40) : "p".repeat(40);
    // The profile requires a private credential directory.
    if (mode === "key-file") f.environment.RUNNER_API_KEY_DIR =
      "/srv/softwarefactory/keys";
    else f.environment.RUNNER_TENANTS_DIR = "/srv/softwarefactory/tenants";
    f.args.localReadiness = async ({ bearer }) => {
      assert.equal(bearer, f.environment.RUNNER_PROBE_BEARER);
      f.calls.push(["ready"]);
      return true;
    };
    const r = await runHostInstall(f.args);
    assert.equal(r.state, "installed");
    const composeArgs = f.calls.find(x=>x[0]==="docker"&&x[1]==="compose");
    assert.ok(composeArgs.join(" ").includes(mode === "key-file"
      ? "compose.runner-key-file.yml" : "compose.tenants.yml"));
    assert.equal(f.held, false);
  }
});

test("apply hard-stops on missing consent, wrong UID, bad paths, bad digest and profile", async () => {
  for (const bad of [
    { mode: "apply", confirmed: false }, { mode: "check", confirmed: true },
    { uid: 0 }, { uid: 1001 }, { envFile: "relative.env" },
    { envFile: "/srv/../private.env" }, { image: "node:22" },
    { image: "node@sha256:" + "G".repeat(64) },
    { commit: "not-a-sha" }, { id: "fake" },
    { authMode: "tenants", operatorRegistry: true },
    { authMode: "unknown" }, { operatorRegistry: "true" },
  ]) {
    const f = fixture();
    await assert.rejects(runHostInstall({ ...f.args, ...bad }),
      /Runner host install refused/);
    assert.deepEqual(f.calls, [], "invalid options must not read credentials or run Docker");
  }
});

test("rejects wrong/replaced Git HEAD, branch and untracked working files before canary", async () => {
  for (const [name,value] of [["rev-parse","c".repeat(40)+"\n"],
    ["symbolic-ref","feature\n"],["status","?? docker/runner/unsafe.sh\n"]]) {
    const f=fixture(), git=f.args.git;
    f.args.git = async argv=>argv[0]===name?value:git(argv);
    await assert.rejects(runHostInstall(f.args), /Runner host install refused/);
    assert.equal(f.up,0);
    assert.equal(f.held,false);
  }
  await assert.rejects(verifyCleanPinnedMain({
    commit: SHA, git: async()=>{throw Error("GIT_TOKEN=secret");},
  }), error=>error.message==="Runner host install refused; inspect the dedicated Linux host manually");
});

test("an invalid Compose/host safety proof blocks canary and installation", async () => {
  for (const [stage, mutation] of [
    ["compose",{apiLoopbackOnly:false}],["compose",{dockerSocketInWorkerOnly:false}],
    ["compose",{status:"failed"}],["host",{dockerRootless:false}],
    ["host",{socketPrivate:false}],["host",{directoriesPrivate:false}],
    ["host",{uid:0}],["host",{status:"failed"}],
  ]) {
    const f=fixture(), prior=f.args.preflightCheck;
    f.args.preflightCheck=async argv=>{
      const valid=await prior(argv);
      return argv[0]===stage?{...valid,...mutation}:valid;
    };
    await assert.rejects(runHostInstall(f.args), /Runner host install refused/);
    assert.equal(f.up,0);
    assert.ok(!f.calls.some(x=>x[0]==="canary"));
  }
});

test("a forged, incomplete or wrong-canary VM acceptance cannot start Compose", async () => {
  const f=fixture();
  for (const patch of [
    {canaryCleanup:"unverified"}, {dockerRootless:false},
    {status:"incomplete"}, {canaryId:randomUUID()},
    {checks:["compose","host"]},
  ]) {
    const v=fixture(), original=v.args.vmAcceptance;
    v.args.vmAcceptance=async options=>({...await original(options),...patch});
    await assert.rejects(runHostInstall(v.args),/Runner host install refused/);
    assert.equal(v.up,0);
    assert.equal(v.held,false);
  }
  void f;
});

test("operator env rotation before, during or after install never yields installed receipt", async () => {
  for (const readAt of [2, 3, 4, 5, 6, 7]) {
    const f=fixture(), base=f.args.readEnv;
    f.args.readEnv=async filename=>{
      const r=await base(filename);
      return f.envReads===readAt?{...r,RUNNER_API_KEY:"X".repeat(40)}:r;
    };
    // Some reads are after startup: in that case evidence remains for
    // manual reconciliation; the installer must not run docker down -v.
    await assert.rejects(runHostInstall(f.args),/Runner host install refused/);
    assert.equal(f.held,false);
    assert.ok(!f.calls.some(x=>x[0]==="docker"&&x.includes("down")));
  }
});

test("any already deployed project, rootful daemon or failed Compose is a hard refusal", async () => {
  for (const change of ["existing","rootful","compose-error","bad-output"]) {
    const f=fixture();
    if(change==="existing") {
      const original=f.args.runDocker;
      f.args.runDocker=(argv,opts)=>argv[0]==="ps" ?
        "a".repeat(12)+"\n" :original(argv,opts);
    } else if(change==="rootful") f.args.probeDocker=async()=>false;
    else if(change==="compose-error") {
      const original=f.args.runDocker;
      f.args.runDocker=(argv,opts)=>argv[0]==="compose" ?
        Promise.reject(Error("RUNNER_API_KEY=should-not-leak")) :original(argv,opts);
    } else {
      const original=f.args.runDocker;
      f.args.runDocker=(argv,opts)=>argv[0]==="ps" ?
        Promise.resolve(null):original(argv,opts);
    }
    await assert.rejects(runHostInstall(f.args),
      error=>error.message==="Runner host install refused; inspect the dedicated Linux host manually");
    assert.equal(f.held,false);
    if(change==="existing"||change==="rootful"||change==="bad-output")
      assert.equal(f.up,0);
  }
});

test("malformed project containers and unavailable/failed readiness cannot certify install", async () => {
  for (const bad of ["missing-one","wrong-service","stopped",
    "wrong-project","bad-id","privileged","api-socket","worker-socket","no-ready"]) {
    const f=fixture(), original=f.args.runDocker;
    if(bad==="no-ready") f.args.localReadiness=async()=>false;
    else f.args.runDocker=async (argv,opts)=>{
      if(argv[0]==="ps"&&f.ps===1&&bad==="missing-one") {
        f.ps++;
        return "a".repeat(12)+"\n";
      }
      if(argv[0]==="inspect") {
        const normal=JSON.parse(await original(argv,opts));
        if(bad==="wrong-service") normal.Config.Labels["com.docker.compose.service"]="evil";
        if(bad==="stopped") normal.State.Running=false;
        if(bad==="wrong-project") normal.Config.Labels["com.docker.compose.project"]="other";
        if(bad==="bad-id") normal.Id="not-a-full-id";
        if(bad==="privileged") normal.HostConfig.Privileged=true;
        if(bad==="api-socket") normal.Mounts=[{ Type: "bind",
          Source: "/var/run/docker.sock", Destination: "/run/docker.sock" }];
        if(bad==="worker-socket") normal.Mounts=[];
        return JSON.stringify(normal);
      }
      return original(argv,opts);
    };
    await assert.rejects(runHostInstall(f.args),/Runner host install refused/);
    assert.equal(f.held,false);
  }
});

test("operator claim prevents two concurrent installers from starting the same stack", async () => {
  let release, entered;
  const pending=new Promise(r=>{release=r;});
  const started=new Promise(r=>{entered=r;});
  let held=false, ups=0;
  const sharedClaim=async()=>{
    if(held)throw Error("EEXIST");
    held=true;
  };
  const sharedUnclaim=async()=>{
    assert.equal(held,true);held=false;
  };
  const f=fixture(), g=fixture();
  for(const obj of [f,g]){
    obj.args.claim=sharedClaim;
    obj.args.unclaim=sharedUnclaim;
    const orig=obj.args.runDocker;
    obj.args.runDocker=async (...args)=>{
      if(args[0][0]==="compose") {
        ups++;
        if(ups===1){entered();await pending;}
      }
      return orig(...args);
    };
  }
  const first=runHostInstall(f.args);
  await started;
  await assert.rejects(runHostInstall(g.args),/Runner host install refused/);
  release();
  assert.equal((await first).installed,true);
  assert.equal(ups,1);
  assert.equal(held,false);
});

test("local authenticated readiness verifies private endpoints, no redirect and no unauth access", async () => {
  const seen=[];
  const fetchImpl=async (url,options)=>{
    seen.push({url,options});
    if(url.endsWith("/v1/capabilities")&&!options.headers.Authorization)
      return {status:401};
    if(url.endsWith("/v1/capabilities"))return {status:200,json:async()=>({
      protocol:1,networkDefault:"none",execution:"remote-docker",steps:["dotnet-build"],
    })};
    if(url.endsWith("/v1/readiness"))return {status:200,json:async()=>({
      status:"ready",worker:"responsive",
    })};
    if(url.endsWith("/v1/execution-readiness"))return {status:200,json:async()=>({
      status:"ready",worker:"responsive",docker:"rootless",
    })};
    assert.fail("unexpected path");
  };
  assert.equal(await probeInstalledRunner({bearer:apiKey,fetchImpl,attempts:1}),true);
  assert.equal(seen.length,4);
  assert.ok(seen.every(x=>x.url.startsWith("http://127.0.0.1:8787/")));
  assert.ok(seen.every(x=>x.options.redirect==="manual"));
  assert.equal(seen[0].options.headers.Authorization,undefined);
  assert.equal(seen[1].options.headers.Authorization,"Bearer "+apiKey);
});

test("local readiness rejects invalid auth, redirect, misleading protocol/rootless and times out", async () => {
  const ok={status:200,json:async()=>({
    protocol:1,networkDefault:"none",execution:"remote-docker",steps:["dotnet-build"],
  })};
  const healthy={status:200,json:async()=>({status:"ready",worker:"responsive",docker:"rootless"})};
  for (const change of ["unauth200","auth401","redirect","badProtocol","notRootless","neverReady"]) {
    const mock=async(url,init)=>{
      if(url.endsWith("/v1/capabilities")&&!init.headers.Authorization)
        return {status:change==="unauth200"?200:401};
      if(url.endsWith("/v1/capabilities"))
        return change==="redirect"?{status:302}:
          change==="auth401"?{status:401}:
          change==="badProtocol"?{status:200,json:async()=>({
            protocol:2,networkDefault:"none",execution:"remote-docker",steps:["dotnet-build"],
          })}:ok;
      if(url.endsWith("/v1/readiness"))
        return change==="neverReady"?{status:503}:healthy;
      if(url.endsWith("/v1/execution-readiness"))
        return change==="notRootless"?{status:200,json:async()=>({
          status:"ready",worker:"responsive",docker:"rootful",
        })}:healthy;
    };
    await assert.rejects(probeInstalledRunner({bearer:apiKey,fetchImpl:mock,
      attempts:2,wait:async()=>{}}),/Runner host install refused/);
  }
  await assert.rejects(probeInstalledRunner({bearer:"x",attempts:1}),
    /Runner host install refused/);
});

test("CLI rejects malformed flags and cannot print forged successful receipt", async () => {
  const accepted=[
    "--env-file="+envFile,"--commit="+SHA,"--image="+IMAGE,"--check",
  ];
  const bad=[
    [],accepted.slice(0,3),["--check"],[...accepted,"--apply"],
    [...accepted,"--confirm-install"],[...accepted,"--check"],
    [...accepted,"--tenants","--runner-key-file"],
    [...accepted,"--tenants","--operator-registry"],
    [...accepted,"--foo"],[...accepted,"--env-file="+envFile],
    ["--env-file=relative",...accepted.slice(1)],
    ["--env-file=/srv/../bad.env",...accepted.slice(1)],
    [...accepted.slice(0,2),"--image=node:22","--check"],
    [...accepted.slice(0,1),"--commit=broken",...accepted.slice(2)],
  ];
  for (const argv of bad) {
    const calls=[];
    await assert.rejects(main(argv,{
      uid:1000,execute:async()=>{calls.push("execute");},
      write:()=>calls.push("output"),
    }),/Runner host install refused/);
    assert.deepEqual(calls,[]);
  }
  const outputs=[];
  const valid=[...accepted.slice(0,3),"--apply","--confirm-install"];
  await assert.rejects(main(valid,{
    uid:1000,
    execute:async()=>({version:1,state:"installed",scope:"local-linux",
      commit:SHA,authMode:"inline",operatorRegistry:false,installed:false,
      dockerRootless:true,project:"sf-runner",
      services:["runner-api","runner-worker"]}),
    write:x=>outputs.push(x),
  }),/Runner host install refused/);
  assert.deepEqual(outputs,[]);
  const good=fixture();
  const result=await main(valid,{
    uid:1000,execute:async()=>runHostInstall(good.args),
    write:x=>outputs.push(x),writeRecovery:()=>{},
  });
  assert.equal(result.installed,true);
  assert.equal(outputs.length,1);
  assert.match(outputs[0],/^RUNNER_HOST_INSTALL_PASS:/);
  assert.ok(!outputs[0].includes(apiKey));
  assert.ok(!outputs[0].includes(envFile));
});
