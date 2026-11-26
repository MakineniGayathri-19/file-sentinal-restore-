/** Largest file accepted (protects the browser from huge in-memory backups). */
export const MAX_FILE_SIZE = 512 * 1024 * 1024;

export function formatTime(t: number | null | undefined): string {
  if (t == null) return "—";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

export function shortHash(h: string | null | undefined): string {
  if (!h) return "—";
  return h.length <= 16 ? h : `${h.slice(0, 16)}…`;
}

/** Letters, digits, dot, dash, underscore only; no leading dots; max 80 chars. */
export function sanitizeFileName(name: string): string {
  let s = (name ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  while (s.startsWith(".")) s = s.slice(1);
  if (s.length > 80) s = s.slice(s.length - 80);
  return s || "file";
}

export function clampScanInterval(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(3600, Math.round(n)));
}

export function csvCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function clampKeepVersions(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(999, Math.round(n)));
}
