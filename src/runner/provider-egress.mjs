/** Off-host Code Reviewer egress: resolve public IPv4 once, pin the
 * validated address to the SAME HTTPS socket and verify TLS for the original
 * hostname. No implicit proxy, redirect following or connection pooling.
 * This is not a DNSSEC proof, provider allowlist or provider attestation.
 */
import {resolve4} from "node:dns/promises";
import {request as httpsRequest} from "node:https";
import {isIP} from "node:net";
import {checkServerIdentity} from "node:tls";

const MAX_RESPONSE_BYTES=65_536;
const MAX_DNS_ADDRESSES=32;
const DEADLINE_MS=30_000;
const fail=()=>Object.assign(new Error("Provider HTTPS egress denied"),
  {code:"AI_REVIEW_INVALID"});

/** Conservative IPv4-only policy, not a claim that an IP belongs to a
 * genuine model vendor. Never permit private, reserved or special-use A
 * records; fail closed if *any* resolved A is unsafe.
 */
export function isPublicProviderIpv4(address) {
  if(typeof address!=="string" || isIP(address)!==4 ||
      !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(address))
    return false;
  const [a,b,c]=address.split(".").map(Number);
  if(a===0 || a===10 || a===127 || a>=224 ||
      a===100 && b>=64 && b<=127 ||
      a===169 && b===254 ||
      a===172 && b>=16 && b<=31 ||
      a===192 && b===168 ||
      a===192 && b===0 && (c===0 || c===2) ||
      a===192 && b===88 && c===99 ||
      a===198 && (b===18 || b===19 || b===51 && c===100) ||
      a===203 && b===0 && c===113)
    return false;
  return true;
}
export function validatePublicProviderEndpoint(input) {
  try {
    const url=new URL(input);
    if(url.protocol!=="https:" || url.username || url.password ||
        url.search || url.hash || url.port && url.port!=="443" ||
        !url.pathname.endsWith("/chat/completions") ||
        url.pathname.includes("//") ||
        !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(url.hostname) ||
        isIP(url.hostname) ||
        /(?:^|\.)localhost$|(?:^|\.)local$|(?:^|\.)internal$/i.test(url.hostname))
      throw fail();
    return url.href;
  }catch {throw fail();}
}
async function beforeDeadline(value,signal){
  if(signal.aborted)throw fail();
  let onAbort;
  const aborted=new Promise((_,reject)=>{
    onAbort=()=>reject(fail());
    signal.addEventListener("abort",onAbort,{once:true});
  });
  try {return await Promise.race([value,aborted]);}
  finally {signal.removeEventListener("abort",onAbort);}
}
async function readTransportResponse(response){
  if(!Number.isInteger(response?.statusCode) ||
      response.statusCode<200 || response.statusCode>=300)
    throw fail();
  const len=response.headers?.["content-length"];
  if(len!==undefined && (typeof len!=="string" ||
      !/^[0-9]+$/.test(len) || Number(len)>MAX_RESPONSE_BYTES))
    throw fail();
  const chunks=[];
  let bytes=0;
  try {
    for await(const chunk of response){
      if(!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))
        throw fail();
      bytes+=chunk.byteLength;
      if(bytes>MAX_RESPONSE_BYTES)throw fail();
      chunks.push(Buffer.from(chunk));
    }
  }catch {response.destroy?.();throw fail();}
  if(bytes<2 || len!==undefined && Number(len)!==bytes)throw fail();
  return new Response(Buffer.concat(chunks,bytes),{
    status:response.statusCode,
    headers:{"content-length":String(bytes)},
  });
}
/** The default client uses DNS A records only (IPv6-only providers fail
 * closed for this first iteration). DNS answers are used once, explicitly
 * on the outbound socket; https.request does NOT resolve the hostname again.
 * The injected resolver/request are for networkless security regression tests,
 * never accepted from CLI flags, files or API responses.
 */
export async function publicProviderHttpsPost({
  endpoint,requestBody,apiKey,
  resolveA=resolve4,requestImpl=httpsRequest,deadlineMs=DEADLINE_MS,
}) {
  try {
    const url=new URL(validatePublicProviderEndpoint(endpoint));
    if(typeof apiKey!=="string" || apiKey.length<16 ||
        typeof requestBody!=="string" || Buffer.byteLength(requestBody)>1_500_000 ||
        !Number.isInteger(deadlineMs) || deadlineMs<1 ||
        deadlineMs>DEADLINE_MS)
      throw fail();
    // A ref'ed timer is needed for a DNS resolver that never settles:
    // AbortSignal.timeout() is unref'ed, so Node might otherwise exit with
    // an uncompleted promise instead of enforcing the promised deadline.
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),deadlineMs);
    const signal=controller.signal;
    try {
    const answers=await beforeDeadline(
      Promise.resolve().then(()=>resolveA(url.hostname)),signal);
    if(!Array.isArray(answers) || answers.length<1 ||
        answers.length>MAX_DNS_ADDRESSES ||
        answers.some(address=>!isPublicProviderIpv4(address)))
      throw fail();
    const pinnedIp=answers[0];
    const response=await beforeDeadline(new Promise((resolve,reject)=>{
      try{
        const request=requestImpl(url,{
          method:"POST",agent:false,signal,
          servername:url.hostname,rejectUnauthorized:true,
          checkServerIdentity,
          lookup:(host,options,callback)=>{
            if(host!==url.hostname){callback(fail());return;}
            callback(null,pinnedIp,4);
          },
          headers:{"Authorization":"Bearer "+apiKey,
            "Content-Type":"application/json","Accept":"application/json"},
        },incoming=>{
          readTransportResponse(incoming).then(resolve,reject);
        });
        request.on("error",reject);
        request.end(requestBody);
      }catch(error){reject(error);}
    }),signal);
    if(signal.aborted)throw fail();
    return response;
    } finally {clearTimeout(timer);}
  }catch {throw fail();}
}
