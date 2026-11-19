/** File-backed actor capability registry for agent lease operations.
 * One bearer is scoped to exactly one tenant + owner + role. The runner
 * job API key is never accepted as a fallback or returned in responses.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 16_384;
const TENANT = /^[a-z][a-z0-9-]{2,31}$/;
const ACTOR = /^[a-z][a-z0-9_-]{1,31}$/;
const ROLES = new Set(["project_manager", "tester", "test_architect",
  "devops_engineer", "code_reviewer", "fullstack_developer",
  "fix_developer", "release_manager", "security_engineer",
  "checkpoint_approver", "review_approver"]);
const fault = code => Object.assign(new Error(code),{code});
const exact = (obj, keys) => obj && typeof obj === "object" && !Array.isArray(obj) &&
  Object.keys(obj).sort().join(",") === [...keys].sort().join(",");

export function validateAgentActorRegistry(value) {
  if (!exact(value, ["version","actors"]) || value.version !== 1 ||
      !Array.isArray(value.actors) || value.actors.length < 1 ||
      value.actors.length > 32) throw fault("ACTOR_AUTH_UNAVAILABLE");
  const names = new Set(), secrets = new Set();
  return value.actors.map(entry => {
    if (!exact(entry, ["id","tenantId","role","key"]) ||
        typeof entry.id !== "string" || !ACTOR.test(entry.id) ||
        !(entry.tenantId === null || typeof entry.tenantId === "string" &&
          TENANT.test(entry.tenantId)) ||
        !ROLES.has(entry.role) ||
        typeof entry.key !== "string" ||
        !entry.key.startsWith("agent." + entry.id + ".") ||
        !/^agent\.[a-z][a-z0-9_-]{1,31}\.[A-Za-z0-9_-]{32,128}$/.test(entry.key))
      throw fault("ACTOR_AUTH_UNAVAILABLE");
    const identity = JSON.stringify([entry.tenantId,entry.id,entry.role]);
    if (names.has(identity) || secrets.has(entry.key))
      throw fault("ACTOR_AUTH_UNAVAILABLE");
    names.add(identity); secrets.add(entry.key);
    return Object.freeze({
      id:entry.id,tenantId:entry.tenantId,role:entry.role,
      keyHash:createHash("sha256").update(entry.key).digest(),
    });
  });
}
export async function loadAgentActorsFile(file) {
  if (typeof constants.O_NOFOLLOW !== "number" ||
      typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0"))
    throw fault("ACTOR_AUTH_UNAVAILABLE");
  let fd;
  try {
    fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    const before=await fd.stat();
    const safe=s=>s.isFile() && s.uid === process.geteuid?.() &&
      s.nlink === 1 && (s.mode & 0o077) === 0 &&
      Number.isSafeInteger(s.size) && s.size >= 64 && s.size <= MAX_BYTES;
    if (!safe(before)) throw Error("unsafe actor registry");
    const buf=Buffer.alloc(before.size);
    let offset=0;
    while (offset<buf.length) {
      const {bytesRead}=await fd.read(buf,offset,buf.length-offset,offset);
      if (!bytesRead) throw Error("truncated registry");
      offset+=bytesRead;
    }
    const after=await fd.stat();
    if (!safe(after) || before.dev!==after.dev || before.ino!==after.ino ||
        before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs ||
        before.mode!==after.mode || before.nlink!==after.nlink ||
        before.size!==after.size)
      throw Error("rotated in place");
    return validateAgentActorRegistry(JSON.parse(buf.toString("utf8")));
  } catch { throw fault("ACTOR_AUTH_UNAVAILABLE"); }
  finally { await fd?.close().catch(()=>{}); }
}
export function authenticateAgentActor(header, registry) {
  if (typeof header !== "string" ||
      !/^Bearer agent\.[a-z][a-z0-9_-]{1,31}\.[A-Za-z0-9_-]{32,128}$/.test(header))
    return null;
  const incoming=createHash("sha256").update(header.slice(7)).digest();
  let found=null;
  for (const actor of registry) {
    if (timingSafeEqual(incoming,actor.keyHash))
      found={id:actor.id,tenantId:actor.tenantId,role:actor.role};
  }
  return found;
}
/** No cache: rotation/revocation checked again while the admission lock is held. */
export async function reauthorizeAgentActor(file, header, expected) {
  const actual=authenticateAgentActor(header,await loadAgentActorsFile(file));
  if (!actual || actual.id!==expected.id ||
      actual.tenantId!==expected.tenantId || actual.role!==expected.role)
    throw fault("ACTOR_AUTH_REVOKED");
  return actual;
}
