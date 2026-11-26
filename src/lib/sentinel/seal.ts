import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { blake3 } from "@noble/hashes/blake3.js";
import type { BackupRecord, StoredFile } from "./types";

/**
 * Registry seal: every baseline and backup record is signed with ML-DSA-65
 * (NIST FIPS 204, the post-quantum signature that Java 24 added in JEP 497).
 * A record edited outside Sentinel no longer matches its signature.
 */
export interface SealKey {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

const enc = new TextEncoder();
const CONTEXT = enc.encode("sentinel-registry-v1");

export function newSealKey(): SealKey {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  return ml_dsa65.keygen(seed);
}

export function fileMessage(
  f: Pick<
    StoredFile,
    "id" | "name" | "size" | "registeredAt" | "baselineHash" | "active" | "algorithm" | "entropy"
  >,
) {
  return enc.encode(
    [
      "file",
      f.id,
      f.name,
      f.size,
      f.registeredAt,
      f.algorithm ?? "SHA-256",
      f.baselineHash,
      f.active ? 1 : 0,
      f.entropy?.toFixed(4) ?? "",
    ].join("\u001f"),
  );
}

export function backupMessage(
  b: Pick<
    BackupRecord,
    "id" | "fileId" | "version" | "sha256" | "size" | "createdAt" | "algorithm"
  >,
) {
  return enc.encode(
    [
      "backup",
      b.id,
      b.fileId,
      b.version,
      b.algorithm ?? "SHA-256",
      b.sha256,
      b.size,
      b.createdAt,
    ].join("\u001f"),
  );
}

const toB64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function sign(key: SealKey, msg: Uint8Array): string {
  return toB64(ml_dsa65.sign(msg, key.secretKey, { context: CONTEXT }));
}

export function verifySeal(key: SealKey, msg: Uint8Array, seal: string | undefined): boolean {
  if (!seal) return false;
  try {
    return ml_dsa65.verify(fromB64(seal), msg, key.publicKey, { context: CONTEXT });
  } catch {
    return false;
  }
}

/** Short, human-checkable fingerprint of the public key (BLAKE3). */
export function keyFingerprint(key: SealKey): string {
  const h = blake3(key.publicKey, { dkLen: 10 });
  return Array.from(h, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .replace(/(.{4})/g, "$1-")
    .slice(0, -1)
    .toUpperCase();
}
