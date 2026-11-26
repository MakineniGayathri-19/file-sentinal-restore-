import { blake3 } from "@noble/hashes/blake3.js";
import { sha3_256 } from "@noble/hashes/sha3.js";

/** Fingerprint algorithms Sentinel can use for baselines and backups. */
export type HashAlgorithm = "SHA-256" | "SHA3-256" | "BLAKE3";
export const HASH_ALGORITHMS: HashAlgorithm[] = ["SHA-256", "SHA3-256", "BLAKE3"];

const CHUNK = 4 * 1024 * 1024;
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Hex digest of bytes. SHA-256 uses Web Crypto; SHA3-256 and BLAKE3 stream in 4 MB chunks so the page stays responsive. */
export async function digestHex(
  data: ArrayBuffer | Blob,
  algorithm: HashAlgorithm = "SHA-256",
): Promise<string> {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  if (algorithm === "SHA-256")
    return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)));
  const h = algorithm === "SHA3-256" ? sha3_256.create() : blake3.create({});
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += CHUNK) {
    h.update(bytes.subarray(i, i + CHUNK));
    if (bytes.length > CHUNK) await tick();
  }
  return toHex(h.digest());
}

/** SHA-256 of bytes, hex encoded (Web Crypto). */
export function sha256Hex(data: ArrayBuffer | Blob): Promise<string> {
  return digestHex(data, "SHA-256");
}

/** Constant-time-ish comparison of two hex hashes. */
export function hashesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Shannon entropy in bits per byte (0–8). Encrypted or random data is close to 8;
 * text and most documents are far lower. Samples at most the first 16 MB.
 */
export function shannonEntropy(buf: ArrayBuffer): number {
  const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, 16 * 1024 * 1024));
  if (!bytes.length) return 0;
  const counts = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) counts[bytes[i]!]!++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const c = counts[i]!;
    if (!c) continue;
    const p = c / bytes.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Thresholds for the ransomware-style alert. */
export const ENTROPY_ENCRYPTED = 7.5;
export const ENTROPY_PLAIN_MAX = 6.5;
export const ENTROPY_MIN_BYTES = 256;

/** True when content went from ordinary to random-looking: the classic sign of a file being encrypted. */
export function looksNewlyEncrypted(
  baseline: number | undefined,
  current: number,
  size: number,
): boolean {
  return (
    baseline !== undefined &&
    size >= ENTROPY_MIN_BYTES &&
    baseline <= ENTROPY_PLAIN_MAX &&
    current >= ENTROPY_ENCRYPTED
  );
}
