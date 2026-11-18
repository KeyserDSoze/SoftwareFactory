import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, lstatSync, readFileSync, rmSync, symlinkSync,
  chmodSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runRebootAudit, main, validateRebootWitness, readWitness,
  writeWitness } from "../scripts/host-reboot-audit.mjs";

const envFile="/srv/softwarefactory/private/runner.env";
const dataDir="/srv/softwarefactory/private/runner-data";
const bootA="12345678-1234-4123-8123-123456789abc";
const bootB="12345678-1234-4123-8123-123456789abd";
const now=Date.parse("2026-11-18T08:45:00.000Z");
const apiKey="s".repeat(64);
const firstEnv={
  RUNNER_API_KEY:apiKey, RUNNER_ALLOWED_ORIGINS:"https://keyserdsoze.github.io",
  RUNNER_DATA_DIR:dataDir,
  RUNNER_HOST_WORK_DIR:"/srv/softwarefactory/private/workspaces",
  RUNNER_DOCKER_SOCKET:"/run/user/1000/docker.sock",
};
const wanted = withTunnel=>withTunnel
  ? ["cloudflared","runner-api","runner-worker"]
  : ["runner-api","runner-worker"];
const identity = { "runner-api": "a".repeat(64),
  "runner-worker": "b".repeat(64), "cloudflared": "c".repeat(64) };
const witness = (withTunnel=false) => ({
  version:1, at:new Date(now-30000).toISOString(),
  bootId:bootA,authMode:"inline",operatorRegistry:false,
  project:"sf-runner",requireTunnel:withTunnel,
  services:wanted(withTunnel),
});
const inspected = service => ({
  Id:identity[service],
  Config:{Labels:{"com.docker.compose.project":"sf-runner",
    "com.docker.compose.service":service}},
  State:{Running:true,Status:"running"},
  HostConfig:{Privileged:false,NetworkMode:"sf-runner_default",
    PortBindings:service==="runner-api"?
      {"8787/tcp":[{HostIp:"127.0.0.1",HostPort:"8787"}]}:{}},
  Mounts:service==="runner-worker"?
    [{Type:"bind",Source:"/run/user/1000/docker.sock",Destination:"/run/docker.sock"}]:[],
});

function fixture(overrides={}) {
  const events=[], state={witness:null,witnessSaved:false,reads:0,probes:0};
  const opts={
    mode:"before",envFile,uid:1000,euid:1000,
    authMode:"inline",requireTunnel:false,operatorRegistry:false,
    now:()=>now,bootId:async()=>bootA,
    readEnv:async ()=>{
      state.reads++;events.push(["env"]);
      return {...firstEnv};
    },
    inspectDataDir:async dir=>{
      events.push(["dir",dir]);
      return {isDirectory:()=>true,isSymbolicLink:()=>false,uid:1000,mode:0o40700};
    },
    preflightCheck:async argv=>{
      events.push(["preflight",argv[0]]);
      return argv[0]==="host"?
        {mode:"host",status:"passed",uid:1000,dockerRootless:true,
         directoriesPrivate:true,socketPrivate:true}:
        {mode:"compose",status:"passed",apiLoopbackOnly:true,
         dockerSocketInWorkerOnly:true,tunnelServiceChecked:true};
    },
    systemCommand:async(cmd,args,settings)=>{
      events.push(["system",cmd,...args]);
      assert.equal(settings.env.DOCKER_HOST,undefined);
      return cmd==="systemctl"?"active\n":"yes\n";
    },
    probeDocker:async ({host})=>{
      assert.equal(host,"unix:///run/user/1000/docker.sock");
      state.probes++;events.push(["probe"]);
      return true;
    },
    dockerCommand:async(cmd,args,settings)=>{
      assert.equal(cmd,"docker");
      assert.equal(settings.env.DOCKER_HOST,"unix:///run/user/1000/docker.sock");
      assert.equal(settings.env.RUNNER_API_KEY,undefined);
      events.push(["docker",...args]);
      if(args[0]==="ps")return wanted(opts.requireTunnel).map(x=>
        identity[x].slice(0,12)).join("\n")+"\n";
      if(args[0]==="inspect"){
        const item=Object.keys(identity).find(x=>
          identity[x].startsWith(args.at(-1)));
        assert.ok(item);
        return JSON.stringify(inspected(item));
      }
      assert.fail("No commands other than Docker ps and inspect");
    },
    readiness:async({bearer})=>{
      assert.equal(bearer,apiKey);
      events.push(["ready"]);
      return true;
    },
    witnessWrite:async(file,record,uid)=>{
      events.push(["write",file]);
      assert.equal(file,path.join(dataDir,".sf-reboot-baseline.v1.json"));
      assert.equal(uid,1000);
      state.witnessSaved=true;state.witness=record;
    },
    witnessRead:async(file,uid)=>{
      events.push(["witness",file]);assert.equal(uid,1000);
      return state.witness||witness(opts.requireTunnel);
    },
  };
  Object.assign(opts,overrides);
  return {opts,events,state};
}
test("before stores a minimal witness only after checked rootless Docker, systemd and authenticated API",async()=>{
  const f=fixture();
  const result=await runRebootAudit(f.opts);
  assert.deepEqual(result,{version:1,state:"baseline_saved",localOnly:true,
    requiresReboot:true,project:"sf-runner",services:wanted(false)});
  assert.equal(f.state.witnessSaved,true);
  assert.equal(f.state.witness.bootId,bootA);
  assert.ok(!JSON.stringify(f.state.witness).includes(apiKey));
  assert.ok(!JSON.stringify(f.state.witness).includes(envFile));
  assert.deepEqual(f.events.filter(x=>x[0]==="docker").map(x=>x[1]),
    ["ps","inspect","inspect"]);
  assert.equal(f.state.probes,3);
  assert.ok(f.events.findIndex(x=>x[0]==="ready") <
    f.events.findIndex(x=>x[0]==="write"));
});
test("after requires different boot ID and all three runtime readiness observations again",async()=>{
  const f=fixture({mode:"after",bootId:async()=>bootB});
  const r=await runRebootAudit(f.opts);
  assert.deepEqual(r,{version:1,state:"different_boot_verified",localOnly:true,
    requiresReboot:false,rootless:true,authenticated:true,
    externalAccessVerified:false,project:"sf-runner",services:wanted(false)});
  assert.ok(f.events.some(x=>x[0]==="witness"));
  assert.ok(!f.events.some(x=>x[0]==="write"));
  assert.equal(f.state.probes,3);
  assert.ok(!JSON.stringify(r).includes(apiKey));
});
test("tunnel profile requires precisely 3 active containers and never declares external Access tested",async()=>{
  const f=fixture({mode:"after",bootId:async()=>bootB,requireTunnel:true});
  const r=await runRebootAudit(f.opts);
  assert.deepEqual(r.services,wanted(true));
  assert.equal(r.externalAccessVerified,false);
  assert.equal(f.state.probes,4);
  assert.equal(f.events.filter(x=>x[0]==="docker"&&x[1]==="inspect").length,3);
});
test("same boot, old/tampered/cross-profile baseline is rejected before any Docker probe",async()=>{
  const edits=[
    {bootId:bootB},{authMode:"tenants"},{project:"wrong"},
    {requireTunnel:true},{services:["runner-worker","runner-api"]},
    {version:2},{at:new Date(now-8*86400000).toISOString()},
    {at:new Date(now+86400000).toISOString()},
    {at:"yesterday"},{extra:"evil"},
  ];
  const f=fixture({mode:"after",bootId:async()=>bootA});
  await assert.rejects(runRebootAudit(f.opts),/Local reboot audit refused/);
  assert.equal(f.state.probes,0);
  for(const edit of edits) {
    const g=fixture({mode:"after",bootId:async()=>bootB});
    g.opts.witnessRead=async()=>({...witness(),...edit});
    await assert.rejects(runRebootAudit(g.opts),/Local reboot audit refused/);
    assert.equal(g.state.probes,0);
  }
});
test("rejects rootful daemon, inactive systemd, no linger, invalid host/Compose preflight",async()=>{
  for(const k of ["rootful","docker-inactive","no-linger","host-failed",
    "compose-failed","wrong-uid","not-private"]) {
    const f=fixture();
    if(k==="rootful")f.opts.probeDocker=async()=>false;
    if(k==="docker-inactive")f.opts.systemCommand=async(cmd)=>
      cmd==="systemctl"?"inactive\n":"yes\n";
    if(k==="no-linger")f.opts.systemCommand=async(cmd)=>
      cmd==="systemctl"?"active\n":"no\n";
    if(k==="host-failed"||k==="compose-failed"){
      const valid=f.opts.preflightCheck;
      f.opts.preflightCheck=async args=>{
        const v=await valid(args);
        return k===args[0]+"-failed"?{...v,status:"failed"}:v;
      };
    }
    if(k==="wrong-uid") f.opts.uid=0;
    if(k==="not-private")f.opts.inspectDataDir=async()=>
      ({isDirectory:()=>true,isSymbolicLink:()=>false,uid:1000,mode:0o40755});
    await assert.rejects(runRebootAudit(f.opts),/Local reboot audit refused/);
    assert.equal(f.state.witnessSaved,false);
  }
});
test("container spoofing, missing mount, wrong network, privileged or published port blocks witness",async()=>{
  for(const k of ["wrong-project","wrong-service","stopped","privileged",
    "wrong-network","api-public","api-socket","worker-socket","bad-full-id",
    "duplicate"]) {
    const f=fixture(), prior=f.opts.dockerCommand;
    f.opts.dockerCommand=async(cmd,args,settings)=>{
      if(k==="duplicate"&&args[0]==="ps")
        return identity["runner-api"].slice(0,12)+"\n".repeat(2);
      if(args[0]!=="inspect")return prior(cmd,args,settings);
      const info=JSON.parse(await prior(cmd,args,settings));
      if(k==="wrong-project")info.Config.Labels["com.docker.compose.project"]="other";
      if(k==="wrong-service")info.Config.Labels["com.docker.compose.service"]="rogue";
      if(k==="stopped")info.State.Running=false;
      if(k==="privileged")info.HostConfig.Privileged=true;
      if(k==="wrong-network")info.HostConfig.NetworkMode="host";
      if(k==="api-public"&&info.Config.Labels["com.docker.compose.service"]==="runner-api")
        info.HostConfig.PortBindings["8787/tcp"][0].HostIp="0.0.0.0";
      if(k==="api-socket"&&info.Config.Labels["com.docker.compose.service"]==="runner-api")
        info.Mounts=[{Type:"bind",Source:"/var/run/docker.sock",Destination:"/run/docker.sock"}];
      if(k==="worker-socket"&&info.Config.Labels["com.docker.compose.service"]==="runner-worker")
        info.Mounts=[];
      if(k==="bad-full-id")info.Id="not-full-id";
      return JSON.stringify(info);
    };
    await assert.rejects(runRebootAudit(f.opts),/Local reboot audit refused/);
    assert.equal(f.state.witnessSaved,false,k);
  }
});
test("readiness failures and env mutation never save a passing local witness",async()=>{
  for(const k of ["auth","missing-private-key","env-drift","wrong-reboot","rootless-interrupted"]) {
    const f=fixture();
    if(k==="auth")f.opts.readiness=async()=>false;
    if(k==="missing-private-key")f.opts.readEnv=async()=>
      ({...firstEnv,RUNNER_API_KEY:"REPLACE_NOT_SECRET"});
    if(k==="env-drift"){
      let n=0;
      f.opts.readEnv=async()=>({...firstEnv,
        RUNNER_API_KEY:++n===2?"u".repeat(64):apiKey});
    }
    if(k==="wrong-reboot"){
      let n=0;
      f.opts.bootId=async()=>++n===1?bootA:bootB;
    }
    if(k==="rootless-interrupted"){
      let n=0;f.opts.probeDocker=async()=>++n<3;
    }
    await assert.rejects(runRebootAudit(f.opts),/Local reboot audit refused/);
    assert.equal(f.state.witnessSaved,false);
  }
});
test("file-key/tenant credentials require private dedicated Bearer and profile-proof",async()=>{
  for(const authMode of ["key-file","tenants"]){
    const f=fixture({authMode});
    const probe=authMode==="tenants"?"team-one."+"q".repeat(40):"p".repeat(40);
    f.opts.readEnv=async()=>({...firstEnv,RUNNER_API_KEY:"",
      RUNNER_PROBE_BEARER:probe,
      ...(authMode==="key-file"?
        {RUNNER_API_KEY_DIR:"/srv/softwarefactory/private/key-dir"}:
        {RUNNER_TENANTS_DIR:"/srv/softwarefactory/private/tenants-dir"})});
    f.opts.preflightCheck=async args=>args[0]==="host"?
      {mode:"host",status:"passed",uid:1000,dockerRootless:true,
      directoriesPrivate:true,socketPrivate:true,credentialMode:authMode,
      credentialsPrivate:true,operatorRegistryChecked:false}:
      {mode:"compose",status:"passed",apiLoopbackOnly:true,
      dockerSocketInWorkerOnly:true,tunnelServiceChecked:true};
    f.opts.readiness=async({bearer})=>{
      assert.equal(bearer,probe);return true;
    };
    const r=await runRebootAudit(f.opts);
    assert.equal(r.state,"baseline_saved");
  }
});
test("actual witness file is 0600 and cannot be overwritten, symlinked or hardlinked",async()=>{
  const base=mkdtempSync(path.join(tmpdir(),"sf-reboot-"));
  const name=path.join(base,"baseline.json");
  const user=process.getuid?.();
  try {
    const w=witness();
    await writeWitness(name,w,user);
    assert.equal(lstatSync(name).mode & 0o777,0o600);
    assert.deepEqual(await readWitness(name,user),w);
    await assert.rejects(writeWitness(name,w,user),/Local reboot audit refused/);
    const link=path.join(base,"witness-link.json");
    symlinkSync(name,link);
    await assert.rejects(readWitness(link,user),/Local reboot audit refused/);
    const hard=path.join(base,"hard.json");
    linkSync(name,hard);
    await assert.rejects(readWitness(name,user),/Local reboot audit refused/);
    rmSync(hard);
    chmodSync(name,0o644);
    await assert.rejects(readWitness(name,user),/Local reboot audit refused/);
  }finally{rmSync(base,{recursive:true,force:true});}
});
test("CLI enforces explicit mode, flags, private env and refuses forged receipts",async()=>{
  const good=["before","--env-file="+envFile];
  const invalid=[
    [],["before"],["before","after","--env-file="+envFile],
    [...good,"--env-file="+envFile],
    ["before","--env-file=relative"],
    [...good,"--tenants","--runner-key-file"],
    [...good,"--tenants","--operator-registry"],
    [...good,"--extra"],
  ];
  for(const flags of invalid){
    const output=[];
    await assert.rejects(main(flags,{execute:async()=>assert.fail("ran"),
      write:x=>output.push(x)}),/Local reboot audit refused/);
    assert.deepEqual(output,[]);
  }
  const result={version:1,state:"baseline_saved",localOnly:true,
    requiresReboot:true,project:"sf-runner",services:wanted(false)};
  const output=[];
  assert.deepEqual(await main(good,{
    execute:async x=>{assert.equal(x.authMode,"inline");return result;},
    write:x=>output.push(x),
  }),result);
  assert.match(output[0],/^RUNNER_REBOOT_BASELINE_PASS:/);
  await assert.rejects(main(["after","--env-file="+envFile],{
    execute:async()=>result,write:()=>assert.fail("printed"),
  }),/Local reboot audit refused/);
});
