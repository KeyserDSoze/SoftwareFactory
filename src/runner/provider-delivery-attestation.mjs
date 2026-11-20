/** Offline verification of an OPTIONAL provider-key-signed HTTP DELIVERY
 * claim. No provider integration or signing function is shipped here.
 * A valid signature proves key possession, NOT actual model execution,
 * vendor identity, usage billing, lease validity or independent approval.
 */
import {createPublicKey,KeyObject,verify} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {canonical,publicKeyFingerprint,
  readAttestationFile,readBoundedJson} from "./attest.mjs";
import {verifyAiReviewReceipt} from "./ai-review-execute.mjs";

const SHA=/^[a-f0-9]{64}$/;
const SIG=/^[A-Za-z0-9_-]{86}$/;
const PROVIDER=/^[a-z][a-z0-9-]{2,63}$/;
const HOST=/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;
const CONTEXT="softwarefactory.ai-review.provider-delivery.v1";
const ASSURANCE="provider_key_signed_delivery_claim_not_execution_or_billing";
const exact=(value,keys)=>value && typeof value==="object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",")===keys.slice().sort().join(",");
const fail=()=>Object.assign(new Error("Provider delivery evidence verification failed"),
  {code:"PROVIDER_DELIVERY_INVALID"});

/** All expected identifiers, host and key pin MUST come from a trusted
 * out-of-band contract, not from the provider evidence or operator receipt.
 * The operator's original signed observation is verified independently.
 */
export function verifyProviderDeliveryEvidence({
  workspace,operatorReceipt,operatorPublicKey,evidence,
  providerPublicKey,expectedProviderId,expectedProviderHost,
  expectedProviderKeySha256,
}) {
  try {
    verifyAiReviewReceipt(workspace,operatorReceipt,operatorPublicKey);
    if(!PROVIDER.test(expectedProviderId) ||
        !HOST.test(expectedProviderHost) ||
        !SHA.test(expectedProviderKeySha256) ||
        !exact(evidence,["version","algorithm","statement",
          "signerKeySha256","signature"]) ||
        evidence.version!==1 || evidence.algorithm!=="Ed25519" ||
        !SHA.test(evidence.signerKeySha256) ||
        typeof evidence.signature!=="string" ||
        !SIG.test(evidence.signature))
      throw fail();
    const observed=operatorReceipt.statement;
    const statement=evidence.statement;
    if(!exact(statement,["version","context","assurance","providerId",
        "providerHost","providerEndpointSha256","requestedModel",
        "requestSha256","responseSha256","usage","issuedAt"]) ||
        statement.version!==1 || statement.context!==CONTEXT ||
        statement.assurance!==ASSURANCE ||
        statement.providerId!==expectedProviderId ||
        statement.providerHost!==expectedProviderHost ||
        statement.providerHost!==observed.providerHost ||
        statement.providerEndpointSha256!==observed.providerEndpointSha256 ||
        statement.requestedModel!==observed.requestedModel ||
        statement.requestSha256!==observed.requestSha256 ||
        statement.responseSha256!==observed.responseSha256 ||
        canonical(statement.usage)!==canonical(observed.usage) ||
        typeof statement.issuedAt!=="string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(statement.issuedAt) ||
        !Number.isFinite(Date.parse(statement.issuedAt)) ||
        new Date(statement.issuedAt).toISOString()!==statement.issuedAt)
      throw fail();
    const key=providerPublicKey instanceof KeyObject &&
      providerPublicKey.type==="public"?
      providerPublicKey:createPublicKey(providerPublicKey);
    const fingerprint=publicKeyFingerprint(key);
    if(key.asymmetricKeyType!=="ed25519" ||
        fingerprint!==expectedProviderKeySha256 ||
        fingerprint!==evidence.signerKeySha256 ||
        fingerprint===operatorReceipt.signerKeySha256)
      throw fail();
    const signature=Buffer.from(evidence.signature,"base64url");
    if(signature.length!==64 || signature.toString("base64url")!==evidence.signature ||
        !verify(null,Buffer.from(canonical(statement)),key,signature))
      throw fail();
    return {verified:true,assurance:ASSURANCE,
      providerId:expectedProviderId,providerHost:expectedProviderHost,
      signerKeySha256:fingerprint,
      requestSha256:statement.requestSha256,
      responseSha256:statement.responseSha256,
      issuedAt:statement.issuedAt};
  }catch {throw fail();}
}

/** Read-only CLI, no API/provider/network requests; a normal OpenAI-compatible
 * /chat/completions response does NOT include this signed evidence.
 */
export async function main(argv=process.argv.slice(2)) {
  const [mode,...options]=argv;
  const expected=["workspace","operator-receipt","operator-public-key",
    "delivery-evidence","provider-public-key","expected-provider-id",
    "expected-provider-host","expected-provider-key-sha256"];
  if(mode!=="verify" || options.length!==expected.length)throw fail();
  const flags=Object.create(null);
  for(const option of options){
    const match=/^--([a-z-]+)=(.+)$/.exec(option);
    if(!match || !expected.includes(match[1]) || flags[match[1]])
      throw fail();
    flags[match[1]]=match[2];
  }
  if(expected.some(key=>!flags[key]))throw fail();
  const [workspace,operatorReceipt,operatorPublicKey,evidence,providerPublicKey]=
    await Promise.all([
      readBoundedJson(flags.workspace,"evidence"),
      readBoundedJson(flags["operator-receipt"],"receipt"),
      readAttestationFile(flags["operator-public-key"],"public-key"),
      readBoundedJson(flags["delivery-evidence"],"receipt"),
      readAttestationFile(flags["provider-public-key"],"public-key"),
    ]);
  const result=verifyProviderDeliveryEvidence({
    workspace,operatorReceipt,
    operatorPublicKey:operatorPublicKey.toString("utf8"),evidence,
    providerPublicKey:providerPublicKey.toString("utf8"),
    expectedProviderId:flags["expected-provider-id"],
    expectedProviderHost:flags["expected-provider-host"],
    expectedProviderKeySha256:flags["expected-provider-key-sha256"],
  });
  process.stdout.write("AI_REVIEW_PROVIDER_DELIVERY_CLAIM_VERIFIED\n");
  return result;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(()=>{
    console.error("AI_REVIEW_PROVIDER_DELIVERY_VERIFICATION_FAILED");
    process.exitCode=1;
  });
