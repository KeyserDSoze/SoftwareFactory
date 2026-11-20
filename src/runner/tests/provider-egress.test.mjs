import assert from "node:assert/strict";
import {test} from "node:test";
import {EventEmitter} from "node:events";
import {Readable} from "node:stream";
import {checkServerIdentity} from "node:tls";
import {isPublicProviderIpv4,validatePublicProviderEndpoint,
  publicProviderHttpsPost} from "../provider-egress.mjs";

const endpoint="https://api.example.com/v1/chat/completions";
const apiKey="operator_only_test_secret_value";
const requestBody=JSON.stringify({model:"review-model",messages:[
  {role:"user",content:"Confidential code belongs only to approved provider."},
]});
function transport({payload='{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}',
  status=200,headers={},onCall=()=>{}}={}) {
  return (url,options,onResponse)=>{
    const req=new EventEmitter();
    req.end=data=>{
      onCall({url,options,data});
      queueMicrotask(()=>{
        const response=Readable.from([Buffer.from(payload)]);
        response.statusCode=status;
        response.headers=headers;
        onResponse(response);
      });
    };
    return req;
  };
}
const opts=(records,requestImpl,options={})=>({
  endpoint,apiKey,requestBody,resolveA:async()=>records,
  requestImpl,...options,
});

test("public IPv4 classifier rejects special-use, RFC1918, metadata, loopback and reserved",()=>{
  for(const address of ["1.1.1.1","8.8.8.8","93.184.216.34",
    "172.32.0.1","192.0.3.1","198.20.1.1","203.0.114.1"])
    assert.equal(isPublicProviderIpv4(address),true,address);
  for(const address of [
    "0.0.0.0","0.1.2.3","10.0.0.7","10.255.255.255",
    "100.64.0.1","100.100.100.100","100.127.255.255",
    "127.0.0.1","127.255.255.254","169.254.169.254",
    "172.16.0.1","172.31.255.255","192.168.1.2",
    "192.0.0.1","192.0.0.9","192.0.2.9","192.88.99.3",
    "198.18.0.1","198.19.255.255","198.51.100.2",
    "203.0.113.24","224.0.0.1","239.255.0.1",
    "240.1.2.3","255.255.255.255","::1",
    "::ffff:127.0.0.1","2001:db8::1",
    "127.1","0177.0.0.1","8.8.8.008","8.8.8.999",
    "fake","",null,undefined,
  ])assert.equal(isPublicProviderIpv4(address),false,String(address));
});

test("hostnames that resolve to any private/mixed/rebinding A cannot create a socket",async()=>{
  let socketCalls=0;
  const requestImpl=()=>{socketCalls++;throw Error("must not connect");};
  for(const answers of [
    [],["127.0.0.1"],["169.254.169.254"],
    ["10.1.2.3"],["172.20.30.40"],["192.168.1.1"],
    ["100.100.100.100"],["192.0.2.10"],["203.0.113.10"],
    ["8.8.8.8","10.2.3.4"],["169.254.169.254","8.8.4.4"],
    ["::1"],["8.8.8.8","::ffff:127.0.0.1"],
    ["8.8.8.8",null],["8.8.8.8","0.0.0.0"],
    new Array(33).fill("8.8.8.8"),"8.8.8.8",
  ]){
    await assert.rejects(
      publicProviderHttpsPost(opts(answers,requestImpl)),
      {code:"AI_REVIEW_INVALID"});
  }
  assert.equal(socketCalls,0);
});

test("HTTPS socket uses ONLY validated DNS A, pinned lookup, hostname TLS validation and no pooling",async()=>{
  const calls=[],dns=[];
  const requestImpl=transport({onCall:data=>calls.push(data)});
  const response=await publicProviderHttpsPost({
    ...opts(["8.8.8.8","1.1.1.1"],requestImpl),
    resolveA:async host=>{dns.push(host);return ["8.8.8.8","1.1.1.1"];},
  });
  assert.equal(response.status,200);
  assert.deepEqual(dns,["api.example.com"]);
  assert.equal(calls.length,1);
  const {url,options,data}=calls[0];
  assert.equal(url.href,endpoint);
  assert.equal(options.method,"POST");
  assert.equal(options.agent,false);
  assert.equal(options.servername,"api.example.com");
  assert.equal(options.rejectUnauthorized,true);
  assert.equal(options.checkServerIdentity,checkServerIdentity);
  assert.equal(options.headers.Authorization,"Bearer "+apiKey);
  assert.equal(options.headers["Content-Type"],"application/json");
  assert.equal(options.headers.Accept,"application/json");
  assert.equal(data,requestBody);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.redirect,undefined);
  let recorded;
  options.lookup("api.example.com",{family:4},(error,ip,family)=>{
    assert.equal(error,null);
    recorded={ip,family};
  });
  assert.deepEqual(recorded,{ip:"8.8.8.8",family:4});
  options.lookup("attacker.internal",{family:4},error=>{
    assert.equal(error.code,"AI_REVIEW_INVALID");
  });
  assert.match(await response.text(),/"choices"/);
  // An independent second invocation rechecks DNS and creates a fresh socket.
  await publicProviderHttpsPost(opts(["1.1.1.1"],requestImpl));
  assert.equal(calls.length,2);
  let pinnedSecond;
  calls[1].options.lookup("api.example.com",{},(_,address)=>pinnedSecond=address);
  assert.equal(pinnedSecond,"1.1.1.1");
});

test("invalid endpoint fails before DNS resolution or socket creation",async()=>{
  let resolutions=0,sockets=0;
  for(const bad of [
    "http://api.example.com/v1/chat/completions",
    "https://127.0.0.1/v1/chat/completions",
    "https://api.local/v1/chat/completions",
    "https://api.example.com:8443/v1/chat/completions",
    "https://name:password@api.example.com/v1/chat/completions",
    "https://api.example.com/v1/chat/completions?secret=oops",
    "https://api.example.com/v1/chat/completions#data",
    "https://api.example.com/v1/not-a-chat",
  ]){
    assert.throws(()=>validatePublicProviderEndpoint(bad),
      {code:"AI_REVIEW_INVALID"});
    await assert.rejects(publicProviderHttpsPost({
      endpoint:bad,requestBody,apiKey,
      resolveA:async()=>{resolutions++;return ["8.8.8.8"];},
      requestImpl:()=>{sockets++;},
    }),{code:"AI_REVIEW_INVALID"});
  }
  assert.equal(resolutions,0);
  assert.equal(sockets,0);
});

test("DNS errors and DNS hangs fail closed without creating TLS sockets",async()=>{
  let sockets=0;
  const requestImpl=()=>{sockets++;throw Error("unexpected socket");};
  for(const resolveA of [
    async()=>{throw Error("DNS error with sensitive hostname");},
    async()=>new Promise(()=>{}),
    async()=>[],
    async()=>["169.254.169.254"],
  ]){
    await assert.rejects(publicProviderHttpsPost({
      endpoint,apiKey,requestBody,resolveA,requestImpl,deadlineMs:30,
    }),{code:"AI_REVIEW_INVALID"});
  }
  assert.equal(sockets,0);
});

test("TLS/socket failures, redirects, oversized or partial responses fail without retry",async()=>{
  for(const response of [
    {status:302},{status:429},{status:503},
    {status:200,payload:"x".repeat(65_537)},
    {status:200,payload:"abc",headers:{"content-length":"70000"}},
    {status:200,payload:"abc",headers:{"content-length":"4"}},
  ]){
    let called=0;
    await assert.rejects(publicProviderHttpsPost(opts(["8.8.8.8"],
      transport({...response,onCall:()=>called++}))),
    {code:"AI_REVIEW_INVALID"});
    assert.equal(called,1,"no retry on potentially billed request");
  }
  let called=0;
  const rejectedSocket=(_url,options,_cb)=>{
    called++;
    const request=new EventEmitter();
    request.end=()=>{
      queueMicrotask(()=>request.emit("error",new Error("TLS verification failed: secret=abc")));
    };
    assert.equal(options.rejectUnauthorized,true);
    return request;
  };
  await assert.rejects(publicProviderHttpsPost(opts(["8.8.8.8"],rejectedSocket)),
    error=>error.code==="AI_REVIEW_INVALID"&&!error.message.includes("secret"));
  assert.equal(called,1);
  const neverRespond=(_url,options,_cb)=>{
    called++;
    const request=new EventEmitter();
    request.end=()=>{};
    assert.ok(options.signal instanceof AbortSignal);
    return request;
  };
  await assert.rejects(publicProviderHttpsPost(opts(["8.8.8.8"],
    neverRespond,{deadlineMs:30})),{code:"AI_REVIEW_INVALID"});
  assert.equal(called,2);
});
