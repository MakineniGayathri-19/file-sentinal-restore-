import type { HashAlgorithm } from "./hash";

export type { HashAlgorithm };

/** Integrity state of a protected file. */
export type FileStatus = "UNCHECKED" | "INTACT" | "MODIFIED" | "MISSING" | "CHECK_ERROR";

export const STATUS_LABEL: Record<FileStatus, string> = {
  UNCHECKED: "UNCHECKED",
  INTACT: "INTACT",
  MODIFIED: "MODIFIED",
  MISSING: "MISSING",
  CHECK_ERROR: "CHECK ERROR",
};

export const isAlert = (s: FileStatus) => s === "MODIFIED" || s === "MISSING";

export type LogType =
  | "REGISTER"
  | "REMOVE"
  | "VERIFY"
  | "MODIFIED"
  | "DELETED"
  | "BACKUP"
  | "RECOVERY"
  | "MONITOR"
  | "BASELINE"
  | "SYSTEM";
export const LOG_TYPES: LogType[] = [
  "REGISTER",
  "REMOVE",
  "VERIFY",
  "MODIFIED",
  "DELETED",
  "BACKUP",
  "RECOVERY",
  "MONITOR",
  "BASELINE",
  "SYSTEM",
];

export type LogResult = "SUCCESS" | "INFO" | "WARNING" | "ERROR";
export const LOG_RESULTS: LogResult[] = ["SUCCESS", "INFO", "WARNING", "ERROR"];

export interface LogEntry {
  id?: number;
  time: number;
  type: LogType;
  target: string;
  description: string;
  result: LogResult;
}

/** Minimal shape of a browser FileSystemFileHandle (so tests can supply fakes). */
export interface WritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
export interface FileHandleLike {
  readonly kind?: string;
  readonly name: string;
  getFile(): Promise<File>;
  createWritable?(): Promise<WritableLike>;
  isSameEntry?(other: FileHandleLike): Promise<boolean>;
  queryPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

/** Persisted part of a protected file. */
export interface StoredFile {
  id: string;
  name: string;
  /** Live link to the file on disk; null when the browser could only give a one-time snapshot. */
  handle: FileHandleLike | null;
  size: number;
  registeredAt: number;
  baselineHash: string;
  active: boolean;
  /** Fingerprint algorithm of the baseline (older records: SHA-256). */
  algorithm?: HashAlgorithm;
  /** Shannon entropy of the baseline content, bits per byte. */
  entropy?: number;
  /** ML-DSA-65 signature over this record. */
  seal?: string;
}

/** How Sentinel can reach the file right now. */
export type FileAccess = "live" | "needs-permission" | "snapshot";

export interface ProtectedFile extends StoredFile {
  status: FileStatus;
  access: FileAccess;
  lastChecked: number | null;
  currentHash: string | null;
  lastMessage: string;
  /** False when the record no longer matches its ML-DSA seal. */
  sealOk: boolean;
  /** Content changed to something that looks encrypted (possible ransomware). */
  suspicious: boolean;
}

export interface BackupRecord {
  id: string;
  fileId: string;
  version: number;
  storedName: string;
  sha256: string;
  size: number;
  createdAt: number;
  note: string;
  originalName: string;
  algorithm?: HashAlgorithm;
  seal?: string;
}

export interface Settings {
  scanIntervalSeconds: number;
  autoStartMonitoring: boolean;
  notifications: boolean;
  /** Algorithm used for newly registered files. */
  hashAlgorithm: HashAlgorithm;
  /** Keep only the newest N versions per file (0 = keep all). The baseline version is always kept. */
  keepVersions: number;
  /** Also show system notifications outside the browser tab. */
  systemNotifications: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  scanIntervalSeconds: 20,
  autoStartMonitoring: false,
  notifications: true,
  hashAlgorithm: "SHA-256",
  keepVersions: 0,
  systemNotifications: false,
};

export interface MonitorEvent {
  time: number;
  fileId: string;
  fileName: string;
  trigger: string;
  previous: FileStatus;
  current: FileStatus;
  suspicious: boolean;
}

export interface RecoveryResult {
  success: boolean;
  message: string;
  restoredHash: string | null;
  matchesBaseline: boolean;
  /** Set when the file can't be written in place and a copy is the way forward. */
  needsCopy?: boolean;
}

/** Thrown for expected, user-facing problems. */
export class SentinelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SentinelError";
  }
}
