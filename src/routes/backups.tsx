import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArchiveRestore,
  Copy,
  DatabaseBackup,
  GitCompare,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, LoadingPage, PageHeader, Panel, StatusBadge } from "@/components/sentinel/ui";
import { useConfirm } from "@/components/sentinel/confirm";
import { errorText } from "@/components/sentinel/actions";
import { DiffDialog, type DiffData } from "@/components/sentinel/DiffDialog";
import { useSentinel } from "@/lib/sentinel/client";
import { formatSize, formatTime, shortHash } from "@/lib/sentinel/format";
import { hashesMatch } from "@/lib/sentinel/hash";
import { downloadBlob, pickSaveTarget, pickSnapshots } from "@/lib/sentinel/pickers";
import { STATUS_LABEL, type BackupRecord, type ProtectedFile } from "@/lib/sentinel/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/backups")({
  head: () => ({
    meta: [
      { title: "Backup & Recovery – Sentinel" },
      {
        name: "description",
        content: "Versioned backups, integrity checks and safe, verified restore.",
      },
      { property: "og:title", content: "Backup & Recovery – Sentinel" },
      {
        property: "og:description",
        content: "Versioned backups, integrity checks and safe, verified restore.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BackupPage,
});

function BackupPage() {
  const s = useSentinel();
  const confirm = useConfirm();
  const [fileId, setFileId] = useState<string>("");
  const [versionId, setVersionId] = useState<string>("");
  const [integrity, setIntegrity] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<DiffData | null>(null);

  const files = s?.active() ?? [];
  const firstId = files[0]?.id;
  const current = files.some((f) => f.id === fileId);
  useEffect(() => {
    if (firstId && !current) setFileId(firstId);
  }, [firstId, current]);

  if (!s) return <LoadingPage />;
  const file = s.findById(fileId);
  const versions = file ? s.getBackups(file.id) : [];
  const chosen = versions.find((v) => v.id === versionId);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error("Something went wrong", { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const chooseAgain = async (f: ProtectedFile) => {
    toast.info(`Choose "${f.name}" again`, {
      description: "This file is a snapshot, so Sentinel needs to see it again.",
    });
    const [picked] = await pickSnapshots(false);
    return picked;
  };

  const createBackup = () =>
    run(async () => {
      if (!file)
        return void toast.message("No file", {
          description: "Register a protected file first (Protected Files screen).",
        });
      let provided: File | undefined;
      if (!file.handle) {
        provided = await chooseAgain(file);
        if (!provided) return;
      }
      await s.verify(file, false, provided);
      const latest = s.latestBackup(file.id);
      if (latest && file.currentHash && hashesMatch(latest.sha256, file.currentHash)) {
        const ok = await confirm({
          title: "Identical backup exists",
          description: `The latest backup (v${latest.version}) already has exactly the same content.\nCreate another version anyway?`,
          confirmLabel: "Create anyway",
        });
        if (!ok) return;
      } else if (file.status !== "INTACT") {
        const ok = await confirm({
          title: `File is ${STATUS_LABEL[file.status]}`,
          description:
            "This file does not match its trusted baseline. A new backup would store the CURRENT (possibly tampered) content.\nYour older backups are not touched.",
          confirmLabel: "Back up anyway",
          tone: "caution",
        });
        if (!ok) return;
      }
      const rec = await s.createBackup(file, "Manual backup", provided);
      toast.success("Backup created", { description: `${file.name} → v${rec.version}` });
    });

  const verifyOne = () =>
    run(async () => {
      if (!chosen)
        return void toast.message("Verify backup", {
          description: "Select a backup version first.",
        });
      const ok = await s.verifyBackup(chosen, true);
      setIntegrity((m) => ({ ...m, [chosen.id]: ok }));
      if (ok) toast.success(`v${chosen.version} : OK`);
      else
        toast.error(`v${chosen.version} : FAILED`, { description: "Do not restore this version." });
    });

  const verifyAllVersions = () =>
    run(async () => {
      let failed = 0;
      const next: Record<string, boolean> = {};
      for (const v of versions) {
        next[v.id] = await s.verifyBackup(v, true);
        if (!next[v.id]) failed++;
      }
      setIntegrity((m) => ({ ...m, ...next }));
      if (failed)
        toast.error("Backup integrity problem", {
          description: `${failed} backup version(s) FAILED verification. Do not restore them.`,
        });
      else toast.success("Backups verified", { description: `${versions.length} version(s) OK` });
    });

  const restoreCopy = async (f: ProtectedFile, b: BackupRecord, reason?: string) => {
    const target = await pickSaveTarget(`restored_v${b.version}_${f.name}`);
    if (!target) return;
    if (target === "download") {
      const blob = await s.recordDownload(f, b);
      if (!blob)
        return void toast.error("Restore failed", {
          description: `Backup v${b.version} failed its integrity check.`,
        });
      downloadBlob(blob, f.status === "MISSING" ? f.name : `restored_v${b.version}_${f.name}`);
      return void toast.success("Copy downloaded", {
        description: reason ?? "Verified copy saved to your downloads.",
      });
    }
    const r = await s.restoreAsCopy(f, b, target);
    if (!r.success) return void toast.error("Restore failed", { description: r.message });
    if (f.status === "MISSING") {
      await s.relink(f, target);
      toast.success("File restored", {
        description: `Sentinel now protects the restored "${target.name}".`,
      });
    } else toast.success("Copy saved", { description: r.message });
  };

  const restore = () =>
    run(async () => {
      if (!file || !chosen)
        return void toast.message("Restore", {
          description: "Select a backup version to restore.",
        });
      if (!file.handle || file.status === "MISSING") {
        const ok = await confirm({
          title: `Restore backup v${chosen.version}`,
          description:
            file.status === "MISSING"
              ? `"${file.name}" is missing. Browsers can't re-create a deleted file by themselves, so you'll choose where to save it – pick the same folder and name to put it back.`
              : `"${file.name}" is a snapshot, so Sentinel can't write to it directly. You'll get a verified copy to save.`,
          confirmLabel: "Choose where to save",
        });
        if (ok) await restoreCopy(file, chosen);
        return;
      }
      const ok = await confirm({
        title: `Restore backup v${chosen.version}`,
        description: `This will OVERWRITE the current file:\n${file.name}\n\nwith backup v${chosen.version} from ${formatTime(chosen.createdAt)}.\nYour browser may ask permission to edit the file.`,
        confirmLabel: "Restore",
        tone: "caution",
      });
      if (!ok) return;
      const r = await s.restore(file, chosen);
      if (!r.success) {
        if (r.needsCopy) {
          const again = await confirm({
            title: "Save a restored copy?",
            description: r.message,
            confirmLabel: "Choose where to save",
          });
          if (again) await restoreCopy(file, chosen);
          return;
        }
        return void toast.error("Restore failed", { description: r.message });
      }
      if (r.matchesBaseline)
        return void toast.success("Restore complete", {
          description: `${file.name} restored from v${chosen.version} – INTACT`,
        });
      const keep = await confirm({
        title: "Restored – differs from baseline",
        description: `Backup v${chosen.version} was restored and verified, but it is NOT the version Sentinel treats as trusted, so the file shows MODIFIED.\n\nMake this restored version the new baseline?`,
        confirmLabel: "Use as new baseline",
        cancelLabel: "Keep current baseline",
        tone: "caution",
      });
      if (keep && r.restoredHash)
        await s.updateBaseline(
          file,
          r.restoredHash,
          `Baseline set to restored backup v${chosen.version}`,
        );
    });

  const compare = () =>
    run(async () => {
      if (!file || !chosen)
        return void toast.message("Compare", { description: "Select a backup version first." });
      let provided: File | undefined;
      if (!file.handle) {
        provided = await chooseAgain(file);
        if (!provided) return;
      }
      const r = await s.compareSources(file, chosen, provided);
      if (!r.ok) return void toast.error("Can't compare", { description: r.message });
      setDiff({
        title: `Changes in ${file.name}`,
        backupLabel: `Backup v${chosen.version}`,
        backupText: r.backupText,
        currentText: r.currentText,
      });
    });

  const copy = () =>
    run(async () => {
      if (!file || !chosen)
        return void toast.message("Restore as copy", {
          description: "Select a backup version first.",
        });
      await restoreCopy(file, chosen);
    });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Backup & Recovery"
        subtitle="Versioned backups, integrity checks and safe restore"
      />
      <DiffDialog data={diff} onClose={() => setDiff(null)} />

      {files.length === 0 ? (
        <EmptyState title="No protected files yet.">
          Register a file on the Protected Files screen; it gets an initial backup automatically.
        </EmptyState>
      ) : (
        <>
          <Panel>
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Select
                  value={fileId}
                  onValueChange={(v) => {
                    setFileId(v);
                    setVersionId("");
                  }}
                >
                  <SelectTrigger className="w-full bg-background sm:w-72">
                    <SelectValue placeholder="Choose a file" />
                  </SelectTrigger>
                  <SelectContent>
                    {files.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {file && (
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    {versions.length} version(s) stored · file status{" "}
                    <StatusBadge status={file.status} />
                  </span>
                )}
              </div>
              <Button size="sm" onClick={createBackup} disabled={busy || !file}>
                <DatabaseBackup /> Create Backup
              </Button>
            </div>
          </Panel>

          <Panel title="Versions">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead>Version</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>Fingerprint</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Integrity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((v) => {
                    const state = s.brokenBackups.has(v.id) ? false : integrity[v.id];
                    const isBaseline = file && hashesMatch(v.sha256, file.baselineHash);
                    return (
                      <TableRow
                        key={v.id}
                        data-state={v.id === versionId ? "selected" : undefined}
                        className="cursor-pointer border-border data-[state=selected]:bg-accent/60"
                        onClick={() => setVersionId(v.id)}
                      >
                        <TableCell className="font-mono font-semibold">
                          v{v.version}
                          {isBaseline && (
                            <span className="ml-2 rounded border border-intact/30 px-1 text-[10px] font-normal text-intact">
                              baseline
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {formatTime(v.createdAt)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatSize(v.size)}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          <span className="text-info">{v.algorithm ?? "SHA-256"}</span>{" "}
                          {shortHash(v.sha256)}
                        </TableCell>
                        <TableCell className="text-sm">{v.note}</TableCell>
                        <TableCell
                          className={cn(
                            "font-mono text-xs",
                            state === true && "text-intact",
                            state === false && "text-missing",
                            state === undefined && "text-muted-foreground",
                          )}
                        >
                          {s.brokenBackups.has(v.id)
                            ? "SEAL BROKEN"
                            : state === undefined
                              ? "not checked"
                              : state
                                ? "OK"
                                : "FAILED"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
              <Button size="sm" variant="subtle" onClick={verifyOne} disabled={busy}>
                <ShieldQuestion /> Verify Selected
              </Button>
              <Button
                size="sm"
                variant="subtle"
                onClick={verifyAllVersions}
                disabled={busy || !versions.length}
              >
                <ShieldCheck /> Verify All Versions
              </Button>
              <Button size="sm" variant="subtle" onClick={compare} disabled={busy}>
                <GitCompare /> Compare with Current
              </Button>
              <Button size="sm" variant="subtle" onClick={copy} disabled={busy}>
                <Copy /> Restore as Copy…
              </Button>
              <Button size="sm" variant="caution" onClick={restore} disabled={busy}>
                <ArchiveRestore /> Restore Selected
              </Button>
            </div>
          </Panel>
          <p className="text-xs text-muted-foreground">
            Backups are kept in this browser's storage on this computer. Old versions are never
            overwritten, each record is signed with ML-DSA-65, and every version is re-checked
            against its fingerprint before it is restored.
            {s.settings.keepVersions > 0 &&
              ` Retention: newest ${s.settings.keepVersions} version(s) plus the baseline version are kept.`}
          </p>
        </>
      )}
    </div>
  );
}
