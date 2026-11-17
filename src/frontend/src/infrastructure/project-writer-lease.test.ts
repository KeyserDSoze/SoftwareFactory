import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireProjectWriterLease } from "./project-writer-lease";

describe("exclusive local writer lease", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubLocks() {
    const active = new Set<string>();
    const seen: Array<{key:string;opts:LockOptions}> = [];
    vi.stubGlobal("navigator", { locks: {
      request: async (key:string, opts:LockOptions, callback:(lock:Lock|null)=>Promise<void>) => {
        seen.push({key,opts});
        if (active.has(key)) return callback(null);
        active.add(key);
        try { return await callback({name:key,mode:"exclusive"} as Lock); }
        finally { active.delete(key); }
      },
    } });
    return {active,seen};
  }

  it("keeps one tab as the only writer until explicit release, then permits takeover", async () => {
    const {active,seen}=stubLocks();
    const id="29b4b450-2d50-4afa-bdf4-d403ecf50764";
    const first=await acquireProjectWriterLease(id);
    expect(active.size).toBe(1);
    expect(seen[0].opts.ifAvailable).toBe(true);
    expect(seen[0].opts.mode).toBe("exclusive");
    await expect(acquireProjectWriterLease(id)).rejects.toThrow(/altra scheda/);
    first.release();
    first.release();
    await vi.waitFor(()=>expect(active.size).toBe(0));
    const second=await acquireProjectWriterLease(id);
    expect(active.size).toBe(1);
    second.release();
    await vi.waitFor(()=>expect(active.size).toBe(0));
  });

  it("allows different project ids concurrently without mixing leases", async () => {
    const {active}=stubLocks();
    const first=await acquireProjectWriterLease("29b4b450-2d50-4afa-bdf4-d403ecf50764");
    const second=await acquireProjectWriterLease("1eb4b450-2d50-4afa-bdf4-d403ecf50764");
    expect(active.size).toBe(2);
    first.release();second.release();
    await vi.waitFor(()=>expect(active.size).toBe(0));
  });

  it("refuses invalid project ids and unsupported browsers rather than writing without a lock", async () => {
    stubLocks();
    await expect(acquireProjectWriterLease("../other")).rejects.toThrow(/ID progetto/);
    vi.stubGlobal("navigator", {});
    await expect(acquireProjectWriterLease("29b4b450-2d50-4afa-bdf4-d403ecf50764"))
      .rejects.toThrow(/Web Locks/);
  });
});
