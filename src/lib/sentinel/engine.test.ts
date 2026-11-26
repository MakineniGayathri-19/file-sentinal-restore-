// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Sentinel } from "./engine";
import { MemoryRepo } from "./repo";
import { clampScanInterval, MAX_FILE_SIZE } from "./format";
import type { FileHandleLike, WritableLike } from "./types";

/** Fake on-disk file reached through a browser-style file handle. */
class FakeHandle implements FileHandleLike {
  readonly kind = "file";
  content: string | null;
  mtime = 1;
  constructor(
    readonly name: string,
    content: string,
  ) {
    this.content = content;
  }
  async getFile() {
    if (this.content === null) throw new DOMException("gone", "NotFoundError");
    return new File([this.content], this.name, { lastModified: this.mtime });
  }
  async createWritable(): Promise<WritableLike> {
    let data: Blob | null = null;
    return {
      write: async (b: Blob) => {
        data = b;
      },
      close: async () => {
        if (this.content === null) throw new DOMException("gone", "NotFoundError");
        this.content = await data!.text();
        this.mtime++;
      },
    };
  }
  async isSameEntry(o: FileHandleLike): Promise<boolean> {
    return o === this;
  }
  async queryPermission() {
    return "granted" as PermissionState;
  }
  edit(s: string) {
    this.content = s;
    this.mtime++;
  }
}

async function setup() {
  const repo = new MemoryRepo();
  const s = new Sentinel(repo, { pollMs: 60_000 });
  await s.init();
  return { s, repo };
}

describe("registration", () => {
  it("registers a file as INTACT with backup v1 matching the baseline", async () => {
    const { s } = await setup();
    const f = await s.register({ handle: new FakeHandle("a.txt", "hello") });
    expect(f.status).toBe("INTACT");
    const b = s.getBackups(f.id);
    expect(b).toHaveLength(1);
    expect(b[0]?.version).toBe(1);
    expect(b[0]?.sha256).toBe(f.baselineHash);
  });

  it("rejects registering the same file twice", async () => {
    const { s } = await setup();
    const h = new FakeHandle("a.txt", "hello");
    await s.register({ handle: h });
    await expect(s.register({ handle: h })).rejects.toThrow(/Already protected/);
    expect(s.active()).toHaveLength(1);
  });

  it("rejects files larger than 512 MB", async () => {
    const { s } = await setup();
    const big = {
      kind: "file",
      name: "big.bin",
      getFile: async () => ({ size: MAX_FILE_SIZE + 1 }) as File,
    };
    await expect(s.register({ handle: big })).rejects.toThrow(/larger than/);
  });

  it("continues the backup history when a removed file is registered again", async () => {
    const { s } = await setup();
    const h = new FakeHandle("a.txt", "one");
    const f = await s.register({ handle: h });
    await s.remove(f);
    expect(s.active()).toHaveLength(0);
    h.edit("two");
    const again = await s.register({ handle: h });
    expect(again.id).toBe(f.id);
    expect(s.getBackups(again.id).map((b) => b.version)).toEqual([2, 1]);
  });
});

describe("verification", () => {
  it("touching a file without changing content stays INTACT", async () => {
    const { s } = await setup();
    const h = new FakeHandle("a.txt", "same");
    const f = await s.register({ handle: h });
    h.edit("same");
    expect(await s.verify(f, true)).toBe("INTACT");
  });

  it("changed content is MODIFIED and logs one alert", async () => {
    const { s } = await setup();
    const h = new FakeHandle("a.txt", "v1");
    const f = await s.register({ handle: h });
    h.edit("tampered");
    expect(await s.verify(f, false)).toBe("MODIFIED");
    await s.verify(f, false);
    expect(s.logs.filter((l) => l.type === "MODIFIED")).toHaveLength(1);
  });

  it("a deleted file is MISSING", async () => {
    const { s } = await setup();
    const h = new FakeHandle("a.txt", "v1");
    const f = await s.register({ handle: h });
    h.content = null;
    expect(await s.verify(f, false)).toBe("MISSING");
    expect(s.logs.some((l) => l.type === "DELETED")).toBe(true);
  });
});

describe("backups and recovery", () => {
  it("version numbers keep counting up and are never reused", async () => {
    const { s } = await setup();
    const h = new FakeHandle("a.txt", "v1");
    const f = await s.register({ handle: h });
    await s.createBackup(f);
    h.edit("v2");
    await s.createBackup(f);
    expect(s.getBackups(f.id).map((b) => b.version)).toEqual([3, 2, 1]);
  });

  it("restoring v1 over a modified file brings it back to INTACT", async () => {
    const { s } = await setup();
    const h = new FakeHandle("a.txt", "original");
    const f = await s.register({ handle: h });
    h.edit("evil");
    await s.verify(f, false);
    const v1 = s.getBackups(f.id)[0]!;
    const r = await s.restore(f, v1);
    expect(r.success).toBe(true);
    expect(h.content).toBe("original");
    expect(f.status).toBe("INTACT");
  });

  it("a corrupted backup is refused and the current file is left untouched", async () => {
    const { s, repo } = await setup();
    const h = new FakeHandle("a.txt", "original");
    const f = await s.register({ handle: h });
    const v1 = s.getBackups(f.id)[0]!;
    repo.blobs.set(v1.id, new Blob(["corrupted"]));
    h.edit("current");
    expect(await s.verifyBackup(v1, false)).toBe(false);
    const r = await s.restore(f, v1);
    expect(r.success).toBe(false);
    expect(h.content).toBe("current");
  });

  it("restoring over a deleted file asks for a copy instead", async () => {
    const { s } = await setup();
    const h = new FakeHandle("a.txt", "original");
    const f = await s.register({ handle: h });
    h.content = null;
    const r = await s.restore(f, s.getBackups(f.id)[0]!);
    expect(r.success).toBe(false);
    expect(r.needsCopy).toBe(true);
  });

  it("removing a file keeps its backups", async () => {
    const { s } = await setup();
    const f = await s.register({ handle: new FakeHandle("a.txt", "x") });
    await s.remove(f);
    expect(s.backups.filter((b) => b.fileId === f.id)).toHaveLength(1);
  });
});

describe("monitoring", () => {
  it("detects a change on the next cycles and records a detection", async () => {
    let now = 1_000;
    const s = new Sentinel(new MemoryRepo(), { pollMs: 60_000, now: () => now });
    await s.init();
    const h = new FakeHandle("a.txt", "v1");
    await s.register({ handle: h });
    s.startMonitoring();
    await s.tick();
    h.edit("v2");
    now += 100;
    await s.tick(); // change seen, debouncing
    now += 500;
    await s.tick(); // quiet long enough -> re-hash
    expect(s.detections[0]?.current).toBe("MODIFIED");
    s.stopMonitoring();
    expect(s.monitorRunning).toBe(false);
  });
});

describe("settings", () => {
  it("defaults to a 20 second safety scan, no auto-start, notifications on", async () => {
    const { s } = await setup();
    expect(s.settings).toMatchObject({
      scanIntervalSeconds: 20,
      autoStartMonitoring: false,
      notifications: true,
    });
  });
  it("scan interval is limited to 0–3600 seconds", () => {
    expect(clampScanInterval(-5)).toBe(0);
    expect(clampScanInterval(99999)).toBe(3600);
  });
  it("settings survive a restart", async () => {
    const repo = new MemoryRepo();
    const a = new Sentinel(repo);
    await a.init();
    await a.saveSettings({
      ...a.settings,
      scanIntervalSeconds: 45,
      autoStartMonitoring: true,
      notifications: false,
    });
    const b = new Sentinel(repo);
    await b.init();
    expect(b.settings.scanIntervalSeconds).toBe(45);
    expect(b.settings.autoStartMonitoring).toBe(true);
  });
});

describe("activity log", () => {
  it("clearing the log leaves one entry recording the clear", async () => {
    const { s } = await setup();
    await s.register({ handle: new FakeHandle("a.txt", "x") });
    await s.clearLogs();
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]?.description).toBe("Activity log cleared by user");
  });
});

describe("advanced algorithms", () => {
  it("SHA3-256 and BLAKE3 baselines detect changes just like SHA-256", async () => {
    for (const algo of ["SHA3-256", "BLAKE3"] as const) {
      const { s } = await setup();
      await s.saveSettings({ ...s.settings, hashAlgorithm: algo });
      const h = new FakeHandle(`${algo}.txt`, "original");
      const f = await s.register({ handle: h });
      expect(f.algorithm).toBe(algo);
      expect(f.baselineHash).toHaveLength(64);
      h.edit("changed");
      expect(await s.verify(f, false)).toBe("MODIFIED");
      const r = await s.restore(f, s.getBackups(f.id)[0]!);
      expect(r.success).toBe(true);
      expect(f.status).toBe("INTACT");
    }
  });

  it("a baseline record edited outside Sentinel fails its ML-DSA seal after restart", async () => {
    const repo = new MemoryRepo();
    const a = new Sentinel(repo, { pollMs: 60_000 });
    await a.init();
    const f = await a.register({ handle: new FakeHandle("a.txt", "x") });
    const stored = repo.files.get(f.id)!;
    repo.files.set(f.id, { ...stored, baselineHash: "0".repeat(64) });
    const b = new Sentinel(repo, { pollMs: 60_000 });
    await b.init();
    const again = b.findById(f.id)!;
    expect(again.sealOk).toBe(false);
    expect(await b.verify(again, false)).toBe("CHECK_ERROR");
  });

  it("an untouched registry passes its seal check after restart", async () => {
    const repo = new MemoryRepo();
    const a = new Sentinel(repo, { pollMs: 60_000 });
    await a.init();
    await a.register({ handle: new FakeHandle("a.txt", "x") });
    const b = new Sentinel(repo, { pollMs: 60_000 });
    await b.init();
    expect(b.sealProblems()).toBe(0);
  });

  it("a backup record edited outside Sentinel cannot be restored", async () => {
    const repo = new MemoryRepo();
    const a = new Sentinel(repo, { pollMs: 60_000 });
    await a.init();
    const h = new FakeHandle("a.txt", "x");
    const f = await a.register({ handle: h });
    const rec = a.getBackups(f.id)[0]!;
    repo.backups.set(rec.id, { ...rec, note: rec.note, size: 999 });
    const b = new Sentinel(repo, { pollMs: 60_000 });
    await b.init();
    const bf = b.findById(f.id)!;
    h.edit("y");
    const r = await b.restore(bf, b.getBackups(f.id)[0]!);
    expect(r.success).toBe(false);
    expect(h.content).toBe("y");
  });

  it("text that becomes random-looking bytes raises a ransomware alert", async () => {
    const { s } = await setup();
    const h = new FakeHandle("doc.txt", "The quick brown fox jumps over the lazy dog. ".repeat(40));
    const f = await s.register({ handle: h });
    const random = crypto.getRandomValues(new Uint8Array(4096));
    // FakeHandle stores strings; serve binary content directly instead.
    h.getFile = async () => new File([random], "doc.txt", { lastModified: 99 });
    await s.verify(f, false);
    expect(f.status).toBe("MODIFIED");
    expect(f.suspicious).toBe(true);
    expect(s.logs.some((l) => l.description.includes("possible ransomware"))).toBe(true);
  });

  it("an ordinary text edit is not flagged as ransomware", async () => {
    const { s } = await setup();
    const h = new FakeHandle("doc.txt", "hello world ".repeat(50));
    const f = await s.register({ handle: h });
    h.edit("goodbye world ".repeat(50));
    await s.verify(f, false);
    expect(f.suspicious).toBe(false);
  });
});

describe("retention policy", () => {
  it("keeps only the newest N versions but never deletes the baseline version", async () => {
    const { s } = await setup();
    await s.saveSettings({ ...s.settings, keepVersions: 2 });
    const h = new FakeHandle("a.txt", "v1");
    const f = await s.register({ handle: h });
    for (const c of ["v2", "v3", "v4"]) {
      h.edit(c);
      await s.createBackup(f);
    }
    expect(s.getBackups(f.id).map((b) => b.version)).toEqual([4, 3, 1]);
  });

  it("0 keeps every version", async () => {
    const { s } = await setup();
    const h = new FakeHandle("a.txt", "v1");
    const f = await s.register({ handle: h });
    for (const c of ["v2", "v3", "v4"]) {
      h.edit(c);
      await s.createBackup(f);
    }
    expect(s.getBackups(f.id)).toHaveLength(4);
  });
});

describe("change viewer", () => {
  it("loads backup and current text for comparison", async () => {
    const { s } = await setup();
    const h = new FakeHandle("a.txt", "line one\nline two\n");
    const f = await s.register({ handle: h });
    h.edit("line one\nline 2\n");
    const r = await s.compareSources(f, s.getBackups(f.id)[0]!);
    expect(r.ok && r.backupText).toBe("line one\nline two\n");
    expect(r.ok && r.currentText).toBe("line one\nline 2\n");
  });
});
