/** Deterministic, evidence-derived tenant turn selection for the POSIX worker queue.
 * Not a distributed scheduler or a durable fair-share ledger: only retained,
 * fully verified job reports provide the last-service history.
 */
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const tenantKey = job => job.tenantId ?? null;

function compareQueued(a, b) {
  return a.acceptedAt.localeCompare(b.acceptedAt) || a.id.localeCompare(b.id);
}

/** Count an actual worker start, including a running claimed job, once it
 * exists in a verified report. Rejected queued jobs have no start timestamp.
 * Retain the MOST RECENT observed start per tenant, not directory scan order.
 */
export function rememberStartedJob(lastStartedByTenant, report) {
  if (typeof report?.startedAt !== "string" || !ISO.test(report.startedAt)) return;
  const at = Date.parse(report.startedAt);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== report.startedAt) return;
  const key = tenantKey(report);
  if (!lastStartedByTenant.has(key) || at > lastStartedByTenant.get(key))
    lastStartedByTenant.set(key, at);
}

/** Oldest queued job within each tenant competes for a turn.
 * Never-served tenants go first; otherwise the least recently started tenant.
 * Ties resolve by oldest acceptedAt and UUID. Legacy jobs form one group,
 * so a completely legacy queue remains FIFO, as before.
 */
export function selectNextQueuedJob(queued, lastStartedByTenant = new Map()) {
  const oldestByTenant = new Map();
  for (const job of queued) {
    const key = tenantKey(job);
    const previous = oldestByTenant.get(key);
    if (!previous || compareQueued(job, previous) < 0)
      oldestByTenant.set(key, job);
  }
  let choice = null;
  for (const candidate of oldestByTenant.values()) {
    if (!choice) { choice = candidate; continue; }
    const started = lastStartedByTenant.get(tenantKey(candidate)) ?? -Infinity;
    const choiceStarted = lastStartedByTenant.get(tenantKey(choice)) ?? -Infinity;
    if (started < choiceStarted ||
        (started === choiceStarted && compareQueued(candidate, choice) < 0))
      choice = candidate;
  }
  return choice;
}
