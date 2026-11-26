import {
  MAX_FILE_SIZE,
  clampKeepVersions,
  clampScanInterval,
  csvCell,
  formatSize,
  formatTime,
  sanitizeFileName,
  shortHash,
} from "./format";
import {
  digestHex,
  hashesMatch,
  looksNewlyEncrypted,
  shannonEntropy,
  type HashAlgorithm,
} from "./hash";
import {
  backupMessage,
  fileMessage,
  keyFingerprint,
  newSealKey,
  sign,
  verifySeal,
  type SealKey,
} from "./seal";
import type { Repo } from "./repo";
import {
  DEFAULT_SETTINGS,
  SentinelError,
  STATUS_LABEL,
  isAlert,
  type BackupRecord,
  type FileAccess,
  type FileHandleLike,
  type FileStatus,
  type LogEntry,
  type LogResult,
  type LogType,
  type MonitorEvent,
  type ProtectedFile,
  type RecoveryResult,
  type Settings,
  type StoredFile,
} from "./types";

const DEBOUNCE_MS = 400;
const MAX_DETECTIONS = 200;

export interface EngineOptions {
  now?: () => number;
  /** How often the monitor polls file handles for changes. */
  pollMs?: number;
  newId?: () => string;
}

type ReadResult =
  | { kind: "ok"; buf: ArrayBuffer; size: number; lastModified: number }
  | { kind: "missing"; message: string }
  | { kind: "error"; message: string; permission?: boolean };

function errName(e: unknown): string {
  return e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
}
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Sentinel core: registry + verification, versioned backups, verified recovery,
 * activity log, settings and a background monitor. UI-agnostic; subscribe() for changes.
 */
export class Sentinel {
  files: ProtectedFile[] = [];
  backups: BackupRecord[] = [];
  logs: LogEntry[] = [];
  settings: Settings = { ...DEFAULT_SETTINGS };
  detections: MonitorEvent[] = [];
  monitorRunning = false;
  ready = false;
  /** Human-checkable fingerprint of this browser's ML-DSA seal key. */
  sealFingerprint = "";
  /** Backup records whose ML-DSA seal no longer matches. */
  brokenBackups = new Set<string>();

  private listeners = new Set<() => void>();
  private monitorListeners = new Set<(e: MonitorEvent) => void>();
  private locks = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastScan = 0;
  private seen = new Map<string, string>();
  private pending = new Map<string, { last: number; trigger: string }>();
  private key: SealKey | null = null;
  private now: () => number;
  private pollMs: number;
  private newId: () => string;

  constructor(
    private repo: Repo,
    opts: EngineOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.pollMs = opts.pollMs ?? 1000;
    this.newId = opts.newId ?? (() => crypto.randomUUID());
  }

  // ------------------------------------------------------------------ events

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onMonitorEvent(fn: (e: MonitorEvent) => void): () => void {
    this.monitorListeners.add(fn);
    return () => this.monitorListeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* listener errors never break the engine */
      }
    }
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(id, settled);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    }
  }

  // ------------------------------------------------------------------ start-up

  async init(): Promise<void> {
    const [stored, backups, logs, settings, key] = await Promise.all([
      this.repo.loadFiles(),
      this.repo.loadBackups(),
      this.repo.loadLogs(),
      this.repo.loadSettings(),
      this.repo.loadSealKey(),
    ]);
    // Trust on first use: a brand-new key seals whatever records already exist.
    const firstKey = !key;
    this.key = key ?? newSealKey();
    if (firstKey) await this.repo.saveSealKey(this.key);
    this.sealFingerprint = keyFingerprint(this.key);
    this.backups = backups;
    this.brokenBackups.clear();
    for (const b of backups) {
      if (firstKey) continue;
      if (!verifySeal(this.key, backupMessage(b), b.seal)) this.brokenBackups.add(b.id);
    }
    this.logs = logs.sort((a, b) => a.time - b.time);
    this.settings = {
      scanIntervalSeconds: clampScanInterval(
        settings?.scanIntervalSeconds ?? DEFAULT_SETTINGS.scanIntervalSeconds,
      ),
      autoStartMonitoring: settings?.autoStartMonitoring ?? DEFAULT_SETTINGS.autoStartMonitoring,
      notifications: settings?.notifications ?? DEFAULT_SETTINGS.notifications,
      hashAlgorithm: settings?.hashAlgorithm ?? DEFAULT_SETTINGS.hashAlgorithm,
      keepVersions: clampKeepVersions(settings?.keepVersions ?? DEFAULT_SETTINGS.keepVersions),
      systemNotifications: settings?.systemNotifications ?? DEFAULT_SETTINGS.systemNotifications,
    };
    this.files = [];
    for (const s of stored) {
      const sealOk = firstKey || verifySeal(this.key, fileMessage(s), s.seal);
      const pf: ProtectedFile = {
        ...s,
        status: "UNCHECKED",
        access: await this.accessFor(s.handle),
        lastChecked: null,
        currentHash: null,
        lastMessage: sealOk ? "Not verified yet" : "Record seal broken",
        sealOk,
        suspicious: false,
      };
      this.files.push(pf);
      if (firstKey && s.seal === undefined) await this.persistFile(pf);
    }
    if (firstKey) {
      for (const b of this.backups) {
        if (!b.seal) {
          b.seal = sign(this.key, backupMessage(b));
          await this.repo.updateBackupRecord(b);
        }
      }
    }
    this.ready = true;
    await this.log(
      "SYSTEM",
      "",
      `Sentinel started (${this.active().length} protected file(s))`,
      "INFO",
    );
    const brokenFiles = this.active().filter((f) => !f.sealOk);
    for (const f of brokenFiles)
      await this.log(
        "SYSTEM",
        f.name,
        "ALERT: baseline record failed its ML-DSA seal check – it was changed outside Sentinel",
        "ERROR",
      );
    if (this.brokenBackups.size)
      await this.log(
        "SYSTEM",
        "",
        `ALERT: ${this.brokenBackups.size} backup record(s) failed their ML-DSA seal check`,
        "ERROR",
      );
  }

  /** Verify everything once and optionally start monitoring (mirrors desktop start-up). */
  async startup(): Promise<void> {
    if (this.active().some((f) => f.access === "live")) await this.verifyAll();
    if (this.settings.autoStartMonitoring) this.startMonitoring();
  }

  private async accessFor(handle: FileHandleLike | null): Promise<FileAccess> {
    if (!handle) return "snapshot";
    if (!handle.queryPermission) return "live";
    try {
      return (await handle.queryPermission({ mode: "read" })) === "granted"
        ? "live"
        : "needs-permission";
    } catch {
      return "needs-permission";
    }
  }

  /** Ask the browser for access again (must be called from a click). */
  async grantAccess(f: ProtectedFile): Promise<boolean> {
    if (!f.handle) return false;
    let state: PermissionState = "granted";
    try {
      if (f.handle.requestPermission) state = await f.handle.requestPermission({ mode: "read" });
    } catch {
      state = "denied";
    }
    f.access = state === "granted" ? "live" : "needs-permission";
    this.emit();
    if (f.access === "live") await this.verify(f, true);
    return f.access === "live";
  }

  /** Seals (ML-DSA-65) and stores a file record. */
  private async persistFile(f: ProtectedFile): Promise<void> {
    if (this.key) f.seal = sign(this.key, fileMessage(f));
    f.sealOk = true;
    await this.repo.saveFile(f);
  }

  private algo(x: { algorithm?: HashAlgorithm }): HashAlgorithm {
    return x.algorithm ?? "SHA-256";
  }

  /** Number of records whose seal is broken (files + backups). */
  sealProblems(): number {
    return this.active().filter((f) => !f.sealOk).length + this.brokenBackups.size;
  }

  // ------------------------------------------------------------------ queries

  active(): ProtectedFile[] {
    return this.files.filter((f) => f.active);
  }
  findById(id: string): ProtectedFile | undefined {
    return this.files.find((f) => f.id === id && f.active);
  }
  count(s: FileStatus): number {
    return this.active().filter((f) => f.status === s).length;
  }
  getBackups(fileId: string): BackupRecord[] {
    return this.backups.filter((b) => b.fileId === fileId).sort((a, b) => b.version - a.version);
  }
  latestBackup(fileId: string): BackupRecord | undefined {
    return this.getBackups(fileId)[0];
  }
  activeBackupCount(): number {
    const ids = new Set(this.active().map((f) => f.id));
    return this.backups.filter((b) => ids.has(b.fileId)).length;
  }

  // ------------------------------------------------------------------ logging

  async log(type: LogType, target: string, description: string, result: LogResult): Promise<void> {
    const e: LogEntry = { time: this.now(), type, target, description, result };
    this.logs = [...this.logs, e];
    this.emit();
    try {
      await this.repo.addLog(e);
    } catch {
      /* the in-memory log still shows it */
    }
  }

  async clearLogs(): Promise<boolean> {
    try {
      await this.repo.clearLogs();
    } catch (e) {
      await this.log("SYSTEM", "", `Failed to clear log: ${errMessage(e)}`, "ERROR");
      return false;
    }
    this.logs = [];
    await this.log("SYSTEM", "", "Activity log cleared by user", "WARNING");
    return true;
  }

  exportCsv(entries: LogEntry[] = this.logs): string {
    const lines = ["Time,Type,Result,Target,Description"];
    for (const e of entries) {
      lines.push(
        [
          csvCell(formatTime(e.time)),
          e.type,
          e.result,
          csvCell(e.target),
          csvCell(e.description),
        ].join(","),
      );
    }
    return lines.join("\n") + "\n";
  }

  // ------------------------------------------------------------------ settings

  async saveSettings(s: Settings): Promise<void> {
    const before = this.settings.keepVersions;
    this.settings = {
      ...s,
      scanIntervalSeconds: clampScanInterval(s.scanIntervalSeconds),
      keepVersions: clampKeepVersions(s.keepVersions),
    };
    await this.repo.saveSettings(this.settings);
    if (this.settings.keepVersions && this.settings.keepVersions !== before) {
      for (const f of this.active()) await this.applyRetention(f.id);
    }
    this.emit();
  }

  // ------------------------------------------------------------------ reading files

  private async read(f: { handle: FileHandleLike | null }, provided?: File): Promise<ReadResult> {
    try {
      let file: File;
      if (provided) file = provided;
      else if (f.handle) file = await f.handle.getFile();
      else return { kind: "error", message: "Snapshot only – choose the file again to check it" };
      if (file.size > MAX_FILE_SIZE)
        return { kind: "error", message: `File is larger than ${formatSize(MAX_FILE_SIZE)}` };
      const buf = await file.arrayBuffer();
      return { kind: "ok", buf, size: buf.byteLength, lastModified: file.lastModified };
    } catch (e) {
      const n = errName(e);
      if (n === "NotFoundError")
        return { kind: "missing", message: "File not found at its registered location" };
      if (n === "NotAllowedError" || n === "SecurityError")
        return {
          kind: "error",
          message: "Browser access to this file was withdrawn – grant access again",
          permission: true,
        };
      if (n === "NotReadableError")
        return { kind: "error", message: "File is not readable right now (it may be changing)" };
      return { kind: "error", message: `Check error: ${errMessage(e)}` };
    }
  }

  // ------------------------------------------------------------------ registration

  /**
   * Registers a file: validate, reject duplicates, hash, initial backup, and
   * double-check the stored backup equals the baseline.
   */
  async register(input: { handle?: FileHandleLike; file?: File }): Promise<ProtectedFile> {
    return this.withLock("__register__", async () => {
      const handle = input.handle ?? null;
      const name = handle?.name ?? input.file?.name ?? "file";
      const fail = async (msg: string, result: LogResult = "WARNING"): Promise<never> => {
        await this.log("REGISTER", name, `Registration rejected: ${msg}`, result);
        throw new SentinelError(msg);
      };
      if (!handle && !input.file) return fail("No file selected");
      if (handle?.kind && handle.kind !== "file")
        return fail("Only regular files can be protected, not folders");

      const r = await this.read({ handle }, handle ? undefined : input.file);
      if (r.kind !== "ok") return fail(r.message);
      const algorithm = this.settings.hashAlgorithm;
      const hash = await digestHex(r.buf, algorithm);

      // duplicates
      for (const f of this.active()) {
        const same =
          handle && f.handle
            ? await this.sameEntry(f.handle, handle)
            : !handle && !f.handle && f.name === name && f.baselineHash === hash;
        if (same) {
          await this.log("REGISTER", name, "Already protected – duplicate ignored", "WARNING");
          throw new SentinelError(`Already protected: ${name}`);
        }
      }

      // A file that was removed earlier keeps its id so its backup history continues.
      let previous: ProtectedFile | undefined;
      if (handle) {
        for (const f of this.files) {
          if (!f.active && f.handle && (await this.sameEntry(f.handle, handle))) {
            previous = f;
            break;
          }
        }
      }

      const now = this.now();
      const pf: ProtectedFile = {
        id: previous?.id ?? this.newId(),
        name,
        handle,
        size: r.size,
        registeredAt: now,
        baselineHash: hash,
        active: true,
        algorithm,
        entropy: shannonEntropy(r.buf),
        sealOk: true,
        suspicious: false,
        status: "UNCHECKED",
        access: handle ? "live" : "snapshot",
        lastChecked: null,
        currentHash: null,
        lastMessage: "Not verified yet",
      };

      try {
        const rec = await this.storeBackup(pf, r.buf, "Initial backup (baseline)");
        if (!hashesMatch(rec.sha256, hash))
          throw new SentinelError(
            "The file changed while it was being registered. Please try again.",
          );
      } catch (e) {
        await this.log("REGISTER", name, `Registration failed: ${errMessage(e)}`, "ERROR");
        throw e;
      }

      pf.status = "INTACT";
      pf.currentHash = hash;
      pf.lastChecked = now;
      pf.lastMessage = "Registered – hash matches baseline";
      if (previous) this.files = this.files.filter((f) => f !== previous);
      this.files.push(pf);
      await this.persistFile(pf);
      this.seen.delete(pf.id);
      await this.log(
        "REGISTER",
        name,
        `Registered; ${algorithm} baseline ${shortHash(hash)} (ML-DSA sealed)`,
        "SUCCESS",
      );
      return pf;
    });
  }

  private async sameEntry(a: FileHandleLike, b: FileHandleLike): Promise<boolean> {
    if (a === b) return true;
    try {
      return a.isSameEntry ? await a.isSameEntry(b) : false;
    } catch {
      return false;
    }
  }

  /** Stops protecting a file. The file on disk AND its backups are kept. */
  async remove(f: ProtectedFile): Promise<void> {
    await this.withLock(f.id, async () => {
      f.active = false;
      await this.persistFile(f);
      this.seen.delete(f.id);
      this.pending.delete(f.id);
    });
    await this.log("REMOVE", f.name, "Removed from protection (file and backups kept)", "INFO");
  }

  /** Points a protected file at a new on-disk location (used after restoring a deleted file). */
  async relink(f: ProtectedFile, handle: FileHandleLike): Promise<void> {
    f.handle = handle;
    f.access = "live";
    await this.persistFile(f);
    this.seen.delete(f.id);
    await this.log("BASELINE", f.name, `Now tracking restored file "${handle.name}"`, "INFO");
    await this.verify(f, false);
  }

  // ------------------------------------------------------------------ verification

  /**
   * Re-hashes the file and compares it with the baseline.
   * @param logResult also write a VERIFY entry (state CHANGES are always logged)
   * @param provided  the file chosen again by the user (for snapshot-only files)
   */
  async verify(f: ProtectedFile, logResult: boolean, provided?: File): Promise<FileStatus> {
    return this.withLock(f.id, async () => {
      if (!f.handle && !provided) {
        f.lastMessage = "Snapshot only – choose the file again to check it";
        this.emit();
        return f.status;
      }
      const before = f.status;
      const wasSuspicious = f.suspicious;
      let after: FileStatus;
      let msg: string;
      let current: string | null = null;
      const r = f.sealOk ? await this.read(f, provided) : null;
      if (!r) {
        after = "CHECK_ERROR";
        msg =
          "Baseline record failed its ML-DSA seal check (changed outside Sentinel). Accept the current content as baseline to re-seal it.";
      } else if (r.kind === "missing") {
        after = "MISSING";
        msg = r.message;
      } else if (r.kind === "error") {
        after = "CHECK_ERROR";
        msg = r.message;
        if (r.permission) f.access = "needs-permission";
      } else {
        current = await digestHex(r.buf, this.algo(f));
        f.size = r.size;
        if (f.handle) f.access = "live";
        if (hashesMatch(current, f.baselineHash)) {
          after = "INTACT";
          msg = "Hash matches baseline";
          f.suspicious = false;
        } else {
          after = "MODIFIED";
          msg = `Hash differs: baseline ${shortHash(f.baselineHash)} → current ${shortHash(current)}`;
          const e = shannonEntropy(r.buf);
          f.suspicious = looksNewlyEncrypted(f.entropy, e, r.size);
          if (f.suspicious)
            msg += `. Content now looks encrypted (entropy ${(f.entropy ?? 0).toFixed(2)} → ${e.toFixed(2)} bits/byte)`;
        }
      }
      if (after !== "MODIFIED" && after !== "INTACT") f.suspicious = false;
      f.currentHash = current;
      f.status = after;
      f.lastChecked = this.now();
      f.lastMessage = msg;
      if (logResult) {
        await this.log(
          "VERIFY",
          f.name,
          `${STATUS_LABEL[after]} – ${msg}`,
          after === "INTACT" ? "SUCCESS" : isAlert(after) ? "WARNING" : "ERROR",
        );
      }
      if (after !== before) await this.logTransition(f, before, after, msg);
      if (f.suspicious && !wasSuspicious)
        await this.log(
          "MODIFIED",
          f.name,
          "ALERT: possible ransomware – the file's content suddenly looks encrypted",
          "ERROR",
        );
      this.emit();
      return after;
    });
  }

  private async logTransition(
    f: ProtectedFile,
    before: FileStatus,
    after: FileStatus,
    msg: string,
  ) {
    switch (after) {
      case "MODIFIED":
        return this.log("MODIFIED", f.name, `ALERT: file content changed. ${msg}`, "WARNING");
      case "MISSING":
        return this.log("DELETED", f.name, "ALERT: protected file is missing", "WARNING");
      case "CHECK_ERROR":
        return this.log("VERIFY", f.name, msg, "ERROR");
      case "INTACT":
        if (before !== "UNCHECKED")
          return this.log("VERIFY", f.name, "File is INTACT again", "SUCCESS");
    }
  }

  /** Verifies every reachable file and writes one summary log entry. */
  async verifyAll(): Promise<Record<FileStatus, number>> {
    const counts: Record<FileStatus, number> = {
      UNCHECKED: 0,
      INTACT: 0,
      MODIFIED: 0,
      MISSING: 0,
      CHECK_ERROR: 0,
    };
    const all = this.active();
    let skipped = 0;
    for (const f of all) {
      if (!f.handle) {
        skipped++;
        counts[f.status]++;
        continue;
      }
      counts[await this.verify(f, false)]++;
    }
    const problems = counts.MODIFIED + counts.MISSING;
    await this.log(
      "VERIFY",
      "",
      `Verified ${all.length - skipped} file(s): ${counts.INTACT} intact, ${counts.MODIFIED} modified, ${counts.MISSING} missing, ${counts.CHECK_ERROR} errors` +
        (skipped ? ` (${skipped} snapshot file(s) need to be chosen again)` : ""),
      problems > 0 ? "WARNING" : "SUCCESS",
    );
    return counts;
  }

  // ------------------------------------------------------------------ baseline

  /** Makes the file's CURRENT content the new trusted baseline (also stores a backup of it). */
  async acceptCurrentAsBaseline(f: ProtectedFile, provided?: File): Promise<void> {
    const r = await this.read(f, provided);
    if (r.kind !== "ok")
      throw new SentinelError("The file is missing or unreadable; nothing to accept.");
    const hash = await digestHex(r.buf, this.algo(f));
    f.baselineHash = hash;
    const rec = await this.storeBackup(f, r.buf, "Baseline updated by user");
    if (!hashesMatch(rec.sha256, hash))
      throw new SentinelError("The file changed during the baseline update. Please try again.");
    await this.updateBaseline(f, hash, "Baseline replaced by current content", provided);
  }

  async updateBaseline(
    f: ProtectedFile,
    newHash: string,
    reason: string,
    provided?: File,
  ): Promise<void> {
    f.baselineHash = newHash;
    const r = await this.read(f, provided);
    if (r.kind === "ok") f.entropy = shannonEntropy(r.buf);
    f.suspicious = false;
    await this.persistFile(f);
    await this.log("BASELINE", f.name, `${reason} → ${shortHash(newHash)}`, "INFO");
    await this.verify(f, false, provided);
  }

  // ------------------------------------------------------------------ backups

  private nextVersion(fileId: string): number {
    return this.backups.reduce((m, b) => (b.fileId === fileId ? Math.max(m, b.version) : m), 0) + 1;
  }

  /** Stores bytes as a new version, then hashes what was actually stored. */
  private async storeBackup(
    f: { id: string; name: string; algorithm?: HashAlgorithm },
    buf: ArrayBuffer,
    note: string,
  ): Promise<BackupRecord> {
    const version = this.nextVersion(f.id);
    const algorithm = this.algo(f);
    const storedName = `v${String(version).padStart(3, "0")}_${sanitizeFileName(f.name)}.bak`;
    const blob = new Blob([buf]);
    const rec: BackupRecord = {
      id: this.newId(),
      fileId: f.id,
      version,
      storedName,
      sha256: await digestHex(buf, algorithm),
      size: buf.byteLength,
      createdAt: this.now(),
      note,
      originalName: f.name,
      algorithm,
    };
    if (this.key) rec.seal = sign(this.key, backupMessage(rec));
    try {
      await this.repo.addBackup(rec, blob);
      // Hash what was actually stored, so the record describes the stored copy.
      const stored = await this.repo.getBackupBlob(rec.id);
      if (!stored || !hashesMatch(await digestHex(stored, algorithm), rec.sha256)) {
        await this.repo.deleteBackup(rec.id);
        throw new Error("the stored copy did not match the file");
      }
      this.backups.push(rec);
      await this.log(
        "BACKUP",
        f.name,
        `Backup v${version} created (${formatSize(buf.byteLength)}) – ${note}`,
        "SUCCESS",
      );
      await this.applyRetention(f.id);
      return rec;
    } catch (e) {
      await this.log("BACKUP", f.name, `Backup failed: ${errMessage(e)}`, "ERROR");
      throw e;
    }
  }

  /** Retention policy: keep the newest N versions, plus the version that matches the baseline. */
  private async applyRetention(fileId: string): Promise<void> {
    const keep = this.settings.keepVersions;
    if (!keep) return;
    const file = this.files.find((f) => f.id === fileId);
    const versions = this.getBackups(fileId);
    const baselineVersion = file
      ? versions.find(
          (v) => this.algo(v) === this.algo(file) && hashesMatch(v.sha256, file.baselineHash),
        )
      : undefined;
    const doomed = versions.slice(keep).filter((v) => v !== baselineVersion);
    for (const v of doomed) {
      try {
        await this.repo.deleteBackup(v.id);
        this.backups = this.backups.filter((b) => b.id !== v.id);
        this.brokenBackups.delete(v.id);
        await this.log(
          "BACKUP",
          v.originalName,
          `Retention policy removed v${v.version} (keeping newest ${keep})`,
          "INFO",
        );
      } catch (e) {
        await this.log(
          "BACKUP",
          v.originalName,
          `Could not remove v${v.version}: ${errMessage(e)}`,
          "ERROR",
        );
      }
    }
  }

  /** Manual backup of the file's current content. */
  async createBackup(
    f: ProtectedFile,
    note = "Manual backup",
    provided?: File,
  ): Promise<BackupRecord> {
    const r = await this.read(f, provided);
    if (r.kind !== "ok") throw new SentinelError(`Cannot back up '${f.name}': ${r.message}`);
    return this.storeBackup(f, r.buf, note);
  }

  /** Recomputes the backup's SHA-256 and compares it with the stored value. */
  async verifyBackup(rec: BackupRecord, logResult: boolean): Promise<boolean> {
    try {
      if (
        this.brokenBackups.has(rec.id) ||
        (this.key && !verifySeal(this.key, backupMessage(rec), rec.seal))
      ) {
        this.brokenBackups.add(rec.id);
        if (logResult)
          await this.log(
            "BACKUP",
            rec.originalName,
            `Backup v${rec.version} verification FAILED: record seal broken (metadata was changed)`,
            "ERROR",
          );
        return false;
      }
      const blob = await this.repo.getBackupBlob(rec.id);
      if (!blob) {
        if (logResult)
          await this.log(
            "BACKUP",
            rec.originalName,
            `Backup v${rec.version} verification FAILED: data missing`,
            "ERROR",
          );
        return false;
      }
      const ok = hashesMatch(await digestHex(blob, this.algo(rec)), rec.sha256);
      if (logResult)
        await this.log(
          "BACKUP",
          rec.originalName,
          `Backup v${rec.version}` +
            (ok
              ? " verified OK"
              : " verification FAILED: content changed (backup is corrupted or tampered)"),
          ok ? "SUCCESS" : "ERROR",
        );
      return ok;
    } catch (e) {
      if (logResult)
        await this.log(
          "BACKUP",
          rec.originalName,
          `Backup v${rec.version} verification error: ${errMessage(e)}`,
          "ERROR",
        );
      return false;
    }
  }

  async getBackupBlob(rec: BackupRecord): Promise<Blob | undefined> {
    return this.repo.getBackupBlob(rec.id);
  }

  // ------------------------------------------------------------------ recovery

  /**
   * Restores a backup over the protected file. Sequence: get write access → verify backup
   * → write (the browser writes to a swap file and replaces the original on close) → re-hash.
   * If any step fails, the existing file is left untouched.
   */
  async restore(f: ProtectedFile, rec: BackupRecord): Promise<RecoveryResult> {
    const label = f.name;
    const fail = async (message: string, needsCopy = false): Promise<RecoveryResult> => {
      await this.log("RECOVERY", label, `Restore failed: ${message}`, "ERROR");
      return {
        success: false,
        message,
        restoredHash: null,
        matchesBaseline: false,
        ...(needsCopy ? { needsCopy } : {}),
      };
    };
    if (rec.fileId !== f.id) return fail("Backup does not belong to this file.");
    const handle = f.handle;
    if (!handle || !handle.createWritable)
      return fail(
        "This file is a one-time snapshot, so it can't be overwritten in place. Use Restore as Copy.",
        true,
      );

    // Ask for write access first, while the user's click still counts.
    if (handle.queryPermission) {
      let state = await handle
        .queryPermission({ mode: "readwrite" })
        .catch(() => "denied" as PermissionState);
      if (state !== "granted" && handle.requestPermission)
        state = await handle
          .requestPermission({ mode: "readwrite" })
          .catch(() => "denied" as PermissionState);
      if (state !== "granted")
        return fail("Permission to write the file was not granted – existing file untouched.");
    }

    if (!(await this.verifyBackup(rec, true)))
      return fail(
        `Backup v${rec.version} failed its integrity check – restore aborted, existing file untouched.`,
      );
    const blob = await this.repo.getBackupBlob(rec.id);
    if (!blob) return fail("Backup data is missing.");

    const result = await this.withLock(f.id, async (): Promise<RecoveryResult | string> => {
      const exists = await this.read(f);
      if (exists.kind === "missing")
        return "The original file was deleted. Browsers can't re-create it in place – save the restored copy to the same folder.";
      let w: Awaited<ReturnType<NonNullable<FileHandleLike["createWritable"]>>> | null = null;
      try {
        w = await handle.createWritable!();
        await w.write(blob);
        await w.close();
        w = null;
      } catch (e) {
        try {
          await w?.abort?.();
        } catch {
          /* ignore */
        }
        if (errName(e) === "NotFoundError")
          return "The original file was deleted. Browsers can't re-create it in place – save the restored copy to the same folder.";
        return `Could not write the file (${errMessage(e)}) – existing file untouched.`;
      }
      const after = await this.read(f);
      if (after.kind !== "ok")
        return `Restored, but the file could not be re-read: ${after.message}`;
      const h = await digestHex(after.buf, this.algo(rec));
      if (!hashesMatch(h, rec.sha256)) return "The restored file does not match the backup hash.";
      this.seen.delete(f.id);
      const baseHash =
        this.algo(rec) === this.algo(f) ? h : await digestHex(after.buf, this.algo(f));
      return {
        success: true,
        message: `Restored backup v${rec.version}; ${this.algo(rec)} verified`,
        restoredHash: baseHash,
        matchesBaseline: hashesMatch(baseHash, f.baselineHash),
      };
    });

    if (typeof result === "string") {
      await this.verify(f, false);
      return fail(result, f.status === "MISSING");
    }
    await this.log(
      "RECOVERY",
      label,
      `Restored backup v${rec.version} (${shortHash(result.restoredHash)}) – verified`,
      "SUCCESS",
    );
    await this.verify(f, false);
    return result;
  }

  /** Writes a verified copy of a backup to a new location chosen by the user. */
  async restoreAsCopy(
    f: ProtectedFile,
    rec: BackupRecord,
    target: FileHandleLike,
  ): Promise<RecoveryResult> {
    const label = target.name;
    if (rec.fileId !== f.id)
      return {
        success: false,
        message: "Backup does not belong to this file.",
        restoredHash: null,
        matchesBaseline: false,
      };
    if (!(await this.verifyBackup(rec, true))) {
      const message = `Backup v${rec.version} failed its integrity check – copy not written.`;
      await this.log("RECOVERY", label, message, "ERROR");
      return { success: false, message, restoredHash: null, matchesBaseline: false };
    }
    const blob = await this.repo.getBackupBlob(rec.id);
    try {
      if (!blob || !target.createWritable) throw new Error("target is not writable");
      const w = await target.createWritable();
      await w.write(blob);
      await w.close();
      const written = await (await target.getFile()).arrayBuffer();
      const h = await digestHex(written, this.algo(rec));
      if (!hashesMatch(h, rec.sha256)) throw new Error("copy does not match the backup hash");
      await this.log(
        "RECOVERY",
        label,
        `Backup v${rec.version} of ${f.name} restored as a verified copy`,
        "SUCCESS",
      );
      const baseHash = this.algo(rec) === this.algo(f) ? h : await digestHex(written, this.algo(f));
      return {
        success: true,
        message: `Verified copy written to ${target.name}`,
        restoredHash: baseHash,
        matchesBaseline: hashesMatch(baseHash, f.baselineHash),
      };
    } catch (e) {
      const message = `Copy failed: ${errMessage(e)}`;
      await this.log("RECOVERY", label, message, "ERROR");
      return { success: false, message, restoredHash: null, matchesBaseline: false };
    }
  }

  /** Records a verified download of a backup (used when the browser can't write files). */
  async recordDownload(f: ProtectedFile, rec: BackupRecord): Promise<Blob | null> {
    if (!(await this.verifyBackup(rec, true))) return null;
    const blob = await this.repo.getBackupBlob(rec.id);
    if (!blob) return null;
    await this.log(
      "RECOVERY",
      f.name,
      `Backup v${rec.version} downloaded as a verified copy`,
      "SUCCESS",
    );
    return blob;
  }

  // ------------------------------------------------------------------ compare

  /** Loads a backup and the file's current content as text, for the change viewer. */
  async compareSources(
    f: ProtectedFile,
    rec: BackupRecord,
    provided?: File,
  ): Promise<
    { ok: true; backupText: string; currentText: string } | { ok: false; message: string }
  > {
    const blob = await this.repo.getBackupBlob(rec.id);
    if (!blob) return { ok: false, message: "Backup data is missing." };
    const r = await this.read(f, provided);
    if (r.kind !== "ok") return { ok: false, message: r.message };
    const a = new Uint8Array(await blob.arrayBuffer());
    const b = new Uint8Array(r.buf);
    if (!isProbablyText(a) || !isProbablyText(b))
      return {
        ok: false,
        message: "This file isn't plain text, so there's nothing readable to compare.",
      };
    const dec = new TextDecoder();
    return { ok: true, backupText: dec.decode(a), currentText: dec.decode(b) };
  }

  // ------------------------------------------------------------------ monitoring

  watchedFiles(): ProtectedFile[] {
    return this.active().filter((f) => f.handle && f.access === "live");
  }

  startMonitoring(): void {
    if (this.monitorRunning) return;
    this.monitorRunning = true;
    this.lastScan = this.now();
    this.seen.clear();
    this.pending.clear();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    void this.log(
      "MONITOR",
      "",
      `Monitoring started (${this.watchedFiles().length} file(s) watched)`,
      "SUCCESS",
    );
  }

  stopMonitoring(): void {
    if (!this.monitorRunning) return;
    this.monitorRunning = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pending.clear();
    void this.log("MONITOR", "", "Monitoring stopped", "INFO");
  }

  /** One monitor cycle: detect changes cheaply, debounce, re-hash, periodic full scan. */
  async tick(): Promise<void> {
    if (!this.monitorRunning || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const f of this.watchedFiles()) {
        let sig: string;
        try {
          const file = await f.handle!.getFile();
          sig = `${file.size}:${file.lastModified}`;
        } catch (e) {
          sig = `err:${errName(e)}`;
        }
        const prev = this.seen.get(f.id);
        this.seen.set(f.id, sig);
        if (prev !== undefined && prev !== sig) {
          this.pending.set(f.id, {
            last: now,
            trigger: sig.startsWith("err:NotFound") ? "file event: delete" : "file event: modify",
          });
        }
      }
      for (const [id, p] of [...this.pending]) {
        if (now - p.last < DEBOUNCE_MS) continue;
        this.pending.delete(id);
        const f = this.findById(id);
        if (f) await this.safeRecheck(f, p.trigger);
      }
      const sec = this.settings.scanIntervalSeconds;
      if (sec > 0 && now - this.lastScan >= sec * 1000) {
        this.lastScan = now;
        for (const f of this.watchedFiles()) await this.safeRecheck(f, "periodic scan");
      }
    } catch (e) {
      await this.log("MONITOR", "", `Monitor cycle failed: ${errMessage(e)}`, "ERROR");
    } finally {
      this.ticking = false;
    }
  }

  private async safeRecheck(f: ProtectedFile, trigger: string) {
    try {
      const before = f.status;
      const after = await this.verify(f, false);
      if (before !== after) {
        const ev: MonitorEvent = {
          time: this.now(),
          fileId: f.id,
          fileName: f.name,
          trigger,
          previous: before,
          current: after,
          suspicious: f.suspicious,
        };
        this.detections = [ev, ...this.detections].slice(0, MAX_DETECTIONS);
        this.emit();
        for (const l of this.monitorListeners) {
          try {
            l(ev);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      await this.log("MONITOR", f.name, `Re-check failed: ${errMessage(e)}`, "ERROR");
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.monitorRunning = false;
  }
}

/** Text check for the change viewer: at most 2 MB and no NUL bytes in the first 8 KB. */
export function isProbablyText(bytes: Uint8Array): boolean {
  if (bytes.length > 2 * 1024 * 1024) return false;
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}

export type { StoredFile };
