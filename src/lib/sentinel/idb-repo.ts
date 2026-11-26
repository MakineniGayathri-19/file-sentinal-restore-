import { openDB, type IDBPDatabase } from "idb";
import type { Repo } from "./repo";
import type { SealKey } from "./seal";
import type { BackupRecord, LogEntry, Settings, StoredFile } from "./types";

const DB_NAME = "sentinel";

/** IndexedDB-backed storage: everything stays in this browser on this computer. */
export function createIdbRepo(): Repo {
  let dbp: Promise<IDBPDatabase> | null = null;
  const db = () =>
    (dbp ??= openDB(DB_NAME, 1, {
      upgrade(d) {
        d.createObjectStore("files", { keyPath: "id" });
        d.createObjectStore("backups", { keyPath: "id" });
        d.createObjectStore("blobs");
        d.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
        d.createObjectStore("settings");
      },
    }));

  return {
    async loadFiles() {
      return (await (await db()).getAll("files")) as StoredFile[];
    },
    async saveFile(f) {
      const {
        id,
        name,
        handle,
        size,
        registeredAt,
        baselineHash,
        active,
        algorithm,
        entropy,
        seal,
      } = f;
      const rec: StoredFile = { id, name, handle, size, registeredAt, baselineHash, active };
      if (algorithm) rec.algorithm = algorithm;
      if (entropy !== undefined) rec.entropy = entropy;
      if (seal) rec.seal = seal;
      await (await db()).put("files", rec);
    },
    async loadBackups() {
      return (await (await db()).getAll("backups")) as BackupRecord[];
    },
    async addBackup(rec, blob) {
      const tx = (await db()).transaction(["backups", "blobs"], "readwrite");
      // add() (not put) rejects an existing key, so a stored version is never overwritten.
      await Promise.all([
        tx.objectStore("backups").add(rec),
        tx.objectStore("blobs").add(blob, rec.id),
        tx.done,
      ]);
    },
    async getBackupBlob(id) {
      return (await (await db()).get("blobs", id)) as Blob | undefined;
    },
    async updateBackupRecord(rec) {
      await (await db()).put("backups", rec);
    },
    async deleteBackup(id) {
      const tx = (await db()).transaction(["backups", "blobs"], "readwrite");
      await Promise.all([
        tx.objectStore("backups").delete(id),
        tx.objectStore("blobs").delete(id),
        tx.done,
      ]);
    },
    async loadLogs() {
      return (await (await db()).getAll("logs")) as LogEntry[];
    },
    async addLog(e) {
      const { id: _ignored, ...rest } = e;
      e.id = (await (await db()).add("logs", rest)) as number;
    },
    async clearLogs() {
      await (await db()).clear("logs");
    },
    async loadSettings() {
      return (await (await db()).get("settings", "settings")) as Partial<Settings> | undefined;
    },
    async saveSettings(s) {
      await (await db()).put("settings", s, "settings");
    },
    async loadSealKey() {
      return (await (await db()).get("settings", "seal-key")) as SealKey | undefined;
    },
    async saveSealKey(k) {
      await (await db()).put("settings", k, "seal-key");
    },
  };
}
