import type { SealKey } from "./seal";
import type { BackupRecord, LogEntry, Settings, StoredFile } from "./types";

/** Persistence boundary. The browser uses IndexedDB; tests use MemoryRepo. */
export interface Repo {
  loadFiles(): Promise<StoredFile[]>;
  saveFile(f: StoredFile): Promise<void>;
  loadBackups(): Promise<BackupRecord[]>;
  /** Must fail when the id already exists: versions are never overwritten. */
  addBackup(rec: BackupRecord, blob: Blob): Promise<void>;
  getBackupBlob(id: string): Promise<Blob | undefined>;
  /** Rewrites a backup's metadata (used once to seal records created before sealing existed). */
  updateBackupRecord(rec: BackupRecord): Promise<void>;
  /** Removes a version (only used by the retention policy). */
  deleteBackup(id: string): Promise<void>;
  loadLogs(): Promise<LogEntry[]>;
  addLog(e: LogEntry): Promise<void>;
  clearLogs(): Promise<void>;
  loadSettings(): Promise<Partial<Settings> | undefined>;
  saveSettings(s: Settings): Promise<void>;
  loadSealKey(): Promise<SealKey | undefined>;
  saveSealKey(k: SealKey): Promise<void>;
}

export class MemoryRepo implements Repo {
  files = new Map<string, StoredFile>();
  backups = new Map<string, BackupRecord>();
  blobs = new Map<string, Blob>();
  logs: LogEntry[] = [];
  settings: Partial<Settings> | undefined;
  sealKey: SealKey | undefined;

  async loadFiles() {
    return [...this.files.values()].map((f) => ({ ...f }));
  }
  async saveFile(f: StoredFile) {
    this.files.set(f.id, { ...f });
  }
  async loadBackups() {
    return [...this.backups.values()];
  }
  async addBackup(rec: BackupRecord, blob: Blob) {
    if (this.backups.has(rec.id)) throw new Error("Backup already exists");
    this.backups.set(rec.id, rec);
    this.blobs.set(rec.id, blob);
  }
  async getBackupBlob(id: string) {
    return this.blobs.get(id);
  }
  async updateBackupRecord(rec: BackupRecord) {
    this.backups.set(rec.id, rec);
  }
  async deleteBackup(id: string) {
    this.backups.delete(id);
    this.blobs.delete(id);
  }
  async loadLogs() {
    return [...this.logs];
  }
  async addLog(e: LogEntry) {
    this.logs.push(e);
  }
  async clearLogs() {
    this.logs = [];
  }
  async loadSettings() {
    return this.settings;
  }
  async saveSettings(s: Settings) {
    this.settings = { ...s };
  }
  async loadSealKey() {
    return this.sealKey;
  }
  async saveSealKey(k: SealKey) {
    this.sealKey = k;
  }
}
