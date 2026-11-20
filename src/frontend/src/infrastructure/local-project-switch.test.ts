import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../domain/defaults";
import type { FactoryProject } from "../domain/types";
import { localProjectSnapshot, loadLocalProject, persistProject,
  persistProjectIfUnchanged } from "./store";
import { assertLocalProjectUnchanged, prepareLocalProjectSwitch,
  readConfirmedLocalProjectSwitch } from "./local-project-switch";

const PREFIX = "softwarefactory.project.library.v1.";
describe("project switch pre-consent snapshot pinning #136", () => {
  const storage = new Map<string, string>();
  let activeGets = 0;
  let onRead: ((key: string, reads: number) => void) | undefined;
  beforeEach(() => {
    storage.clear();
    activeGets = 0;
    onRead = undefined;
    vi.stubGlobal("localStorage", {
      get length() { return storage.size; },
      key: (i: number) => [...storage.keys()][i] ?? null,
      getItem: (key: string) => {
        if (key.startsWith(PREFIX)) activeGets++;
        onRead?.(key, activeGets);
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    });
    vi.stubGlobal("sessionStorage", {
      getItem: () => null, setItem: () => {},
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  function project(label: string): FactoryProject {
    const p = createProject();
    p.config.name = label;
    return p;
  }
  function otherVersion(p: FactoryProject, label: string) {
    return { ...p, config: { ...p.config, name: label },
      updatedAt: "2026-11-20T12:00:00.000Z" };
  }

  it("pins snapshot before user consent; rejects change during modal and preserves new bytes", () => {
    const original = project("Before consent");
    persistProject(original);
    const ticket = prepareLocalProjectSwitch(original.id);
    expect(ticket.displayName).toBe("Before consent");
    // Another cooperative writer owns the lock while our user confirms.
    const updated = otherVersion(original, "Updated during confirmation");
    persistProject(updated);
    expect(() => readConfirmedLocalProjectSwitch(ticket)).toThrow(/Conflitto locale/);
    expect(loadLocalProject(original.id).config.name).toBe("Updated during confirmation");
    expect(localProjectSnapshot(original.id)).toBe(JSON.stringify(updated));
  });

  it("detects mutation between the initial snapshot and initial validation read", () => {
    const original = project("Before first read");
    persistProject(original);
    // The authoritative slot commit now includes an exact getItem readback.
    // Reset the read counter BEFORE injecting the concurrent edit, so read
    // #2 still means the second read of prepareLocalProjectSwitch().
    activeGets = 0;
    const updated = otherVersion(original, "Concurrent first read");
    const key = PREFIX + original.id;
    let didChange = false;
    onRead = (current, count) => {
      if (!didChange && current === key && count === 2) {
        storage.set(key, JSON.stringify(updated));
        didChange = true;
      }
    };
    expect(() => prepareLocalProjectSwitch(original.id)).toThrow(/Conflitto locale/);
    expect(didChange).toBe(true);
    expect(localProjectSnapshot(original.id)).toBe(JSON.stringify(updated));
  });

  it("rejects an update between the two post-lease readbacks", () => {
    const original = project("Before granted lease");
    persistProject(original);
    const ticket = prepareLocalProjectSwitch(original.id);
    const updated = otherVersion(original, "Changed during locked read");
    const key = PREFIX + original.id;
    activeGets = 0;
    let changed = false;
    onRead = (current, count) => {
      if (!changed && current === key && count === 2) {
        storage.set(key, JSON.stringify(updated));
        changed = true;
      }
    };
    expect(() => readConfirmedLocalProjectSwitch(ticket)).toThrow(/Conflitto locale/);
    expect(changed).toBe(true);
    expect(localProjectSnapshot(original.id)).toBe(JSON.stringify(updated));
  });

  it("reloads current normalized pending project only after the snapshot is pinned", () => {
    const original = project("Running fixture");
    original.stages[0].status = "running";
    persistProject(original);
    const ticket = prepareLocalProjectSwitch(original.id);
    const verified = readConfirmedLocalProjectSwitch(ticket);
    expect(verified.project.stages[0].status).toBe("pending");
    expect(verified.snapshot).toBe(JSON.stringify(original));
    // A normalized project is written only through an exact original baseline.
    const confirmed = persistProjectIfUnchanged(verified.project, verified.snapshot);
    expect(loadLocalProject(original.id).stages[0].status).toBe("pending");
    expect(confirmed).toBe(JSON.stringify(verified.project));
  });

  it("blocks a newly-created or changed target during lease acquisition", () => {
    const next = project("External import");
    const emptyBaseline = localProjectSnapshot(next.id);
    expect(emptyBaseline).toBeNull();
    persistProject(next); // Rival tab added this ID while our lease was pending.
    expect(() => assertLocalProjectUnchanged(next.id, emptyBaseline))
      .toThrow(/Conflitto locale/);
    const baseline = localProjectSnapshot(next.id);
    const updated = otherVersion(next, "Cloud restore conflict");
    persistProject(updated);
    expect(() => assertLocalProjectUnchanged(next.id, baseline))
      .toThrow(/Conflitto locale/);
    expect(loadLocalProject(next.id).config.name).toBe("Cloud restore conflict");
  });

  it("accepts unchanged targets and rejects missing/malformed projects without mutation", () => {
    const p = project("Valid");
    persistProject(p);
    const ticket = prepareLocalProjectSwitch(p.id);
    expect(readConfirmedLocalProjectSwitch(ticket).project.config.name).toBe("Valid");
    expect(() => prepareLocalProjectSwitch("../invalid")).toThrow(/ID progetto/);
    storage.delete(PREFIX + p.id);
    expect(() => readConfirmedLocalProjectSwitch(ticket)).toThrow(/Conflitto locale/);
    expect(() => prepareLocalProjectSwitch(p.id)).toThrow(/non trovato/);
    const stale = project("Broken");
    storage.set(PREFIX + stale.id, "{oops");
    expect(() => prepareLocalProjectSwitch(stale.id)).toThrow(/non valido/);
  });
});
