import { createFileRoute } from "@tanstack/react-router";
import { useState, type DragEvent } from "react";
import { toast } from "sonner";
import { CheckCheck, FilePlus2, RefreshCw, ShieldCheck, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AccessLabel,
  EmptyState,
  LoadingPage,
  PageHeader,
  Panel,
  StatusBadge,
  SuspiciousBadge,
} from "@/components/sentinel/ui";
import { useConfirm } from "@/components/sentinel/confirm";
import { errorText, registerPicked } from "@/components/sentinel/actions";
import { useSentinel } from "@/lib/sentinel/client";
import { formatSize, formatTime, shortHash } from "@/lib/sentinel/format";
import { fromDrop, pickFilesToProtect, pickSnapshots } from "@/lib/sentinel/pickers";
import { STATUS_LABEL, type ProtectedFile } from "@/lib/sentinel/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/files")({
  head: () => ({
    meta: [
      { title: "Protected Files – Sentinel" },
      {
        name: "description",
        content: "Register files, record their SHA-256 fingerprints and manage protection.",
      },
      { property: "og:title", content: "Protected Files – Sentinel" },
      {
        property: "og:description",
        content: "Register files, record their SHA-256 fingerprints and manage protection.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ProtectedFilesPage,
});

function ProtectedFilesPage() {
  const s = useSentinel();
  const confirm = useConfirm();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const files = s?.active() ?? [];
  const q = filter.trim().toLowerCase();
  const shown = q
    ? files.filter(
        (f) => f.name.toLowerCase().includes(q) || STATUS_LABEL[f.status].toLowerCase().includes(q),
      )
    : files;

  if (!s) return <LoadingPage />;
  const sel = files.filter((f) => selected.has(f.id));
  const one = sel.length === 1 ? sel[0] : undefined;

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

  const add = () => run(async () => registerPicked(s, await pickFilesToProtect()));

  const onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    setDragging(false);
    const p = fromDrop(ev.dataTransfer);
    void run(async () => registerPicked(s, await p));
  };

  /** Snapshot files must be chosen again; ask once for a single file. */
  const providedFor = async (f: ProtectedFile): Promise<File | undefined | null> => {
    if (f.handle) return undefined;
    toast.info(`Choose "${f.name}" again`, {
      description: "This file is a snapshot, so Sentinel needs to see it again.",
    });
    const [picked] = await pickSnapshots(false);
    return picked ?? null;
  };

  const verifySelected = () =>
    run(async () => {
      if (!sel.length)
        return void toast.message("Verify", { description: "Select one or more files first." });
      const snapshots = sel.filter((f) => !f.handle);
      for (const f of sel.filter((x) => x.handle)) await s.verify(f, true);
      if (snapshots.length === 1 && snapshots[0]) {
        const file = await providedFor(snapshots[0]);
        if (file) await s.verify(snapshots[0], true, file);
      } else if (snapshots.length > 1) {
        toast.message(`${snapshots.length} snapshot files skipped`, {
          description: "Select them one at a time to choose each file again.",
        });
      }
    });

  const verifyAll = () =>
    run(async () => {
      const c = await s.verifyAll();
      const bad = c.MODIFIED + c.MISSING;
      if (bad)
        toast.warning("Verification finished", { description: `${bad} file(s) need attention` });
      else
        toast.success("Verification finished", { description: "All reachable files are intact" });
    });

  const acceptBaseline = () =>
    run(async () => {
      if (!one)
        return void toast.message("Accept as baseline", {
          description: "Select exactly one file.",
        });
      const ok = await confirm({
        title: "Accept current content?",
        description: `The CURRENT content of "${one.name}" becomes the trusted baseline and a new backup is stored.\n\nOnly do this if you made the change yourself.`,
        confirmLabel: "Accept as baseline",
        tone: "caution",
      });
      if (!ok) return;
      const file = await providedFor(one);
      if (file === null) return;
      await s.acceptCurrentAsBaseline(one, file);
      toast.success("Baseline updated", { description: one.name });
    });

  const remove = () =>
    run(async () => {
      if (!sel.length)
        return void toast.message("Remove", { description: "Select one or more files first." });
      const ok = await confirm({
        title: `Stop protecting ${sel.length === 1 ? `"${sel[0]?.name}"` : `${sel.length} file(s)`}?`,
        description:
          "The files on your computer are NOT deleted and their backups are kept.\nSentinel will simply stop monitoring them.",
        confirmLabel: "Remove from protection",
        tone: "danger",
      });
      if (!ok) return;
      for (const f of sel) await s.remove(f);
      setSelected(new Set());
    });

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const allShownSelected = shown.length > 0 && shown.every((f) => selected.has(f.id));

  return (
    <div
      className="space-y-6"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <PageHeader
        title="Protected Files"
        subtitle="Register files, verify their SHA-256 and manage protection"
        actions={
          <Button onClick={add} disabled={busy}>
            <FilePlus2 /> Add Files
          </Button>
        }
      />

      <div
        className={cn(
          "flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-6 py-6 text-center text-sm transition-colors",
          dragging ? "border-primary bg-primary/10" : "border-border bg-card/40",
        )}
      >
        <Upload className="size-5 text-muted-foreground" />
        <p>
          Drag files here, or{" "}
          <button
            type="button"
            onClick={add}
            className="text-primary underline-offset-4 hover:underline"
          >
            choose files
          </button>
        </p>
        <p className="text-xs text-muted-foreground">
          Each file gets a SHA-256 baseline and an initial backup. Up to 512 MB per file.
        </p>
      </div>

      <Panel>
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or status"
            className="max-w-xs bg-background"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="subtle" onClick={verifySelected} disabled={busy}>
              <ShieldCheck /> Verify Selected
            </Button>
            <Button size="sm" variant="subtle" onClick={verifyAll} disabled={busy || !files.length}>
              <RefreshCw /> Verify All
            </Button>
            <Button size="sm" variant="caution" onClick={acceptBaseline} disabled={busy}>
              <CheckCheck /> Accept as Baseline
            </Button>
            <Button size="sm" variant="danger" onClick={remove} disabled={busy}>
              <Trash2 /> Remove
            </Button>
          </div>
        </div>

        {files.length === 0 ? (
          <EmptyState title="No protected files yet">
            Add the files you care about. Sentinel will tell you the moment one changes or
            disappears.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="w-8">
                    <Checkbox
                      checked={allShownSelected}
                      onCheckedChange={(v) =>
                        setSelected(v ? new Set(shown.map((f) => f.id)) : new Set())
                      }
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Registered</TableHead>
                  <TableHead>Last checked</TableHead>
                  <TableHead>Baseline</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((f) => (
                  <TableRow
                    key={f.id}
                    data-state={selected.has(f.id) ? "selected" : undefined}
                    className="cursor-pointer border-border data-[state=selected]:bg-accent/60"
                    onClick={() => setSelected(new Set([f.id]))}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(f.id)}
                        onCheckedChange={(v) => toggle(f.id, !!v)}
                        aria-label={`Select ${f.name}`}
                      />
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-col items-start gap-1">
                        <StatusBadge status={f.status} />
                        {f.suspicious && <SuspiciousBadge />}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate font-medium" title={f.name}>
                      {f.name}
                    </TableCell>
                    <TableCell>
                      <AccessLabel access={f.access} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {formatSize(f.size)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {formatTime(f.registeredAt)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {formatTime(f.lastChecked)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      <span className="text-info">{f.algorithm ?? "SHA-256"}</span>{" "}
                      {shortHash(f.baselineHash)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      {one && (
        <Panel title={`Details – ${one.name}`}>
          <dl className="grid gap-2 font-mono text-xs">
            <div className="grid gap-1 sm:grid-cols-[6rem_1fr]">
              <dt className="text-muted-foreground">Baseline</dt>
              <dd className="break-all">{one.baselineHash}</dd>
            </div>
            <div className="grid gap-1 sm:grid-cols-[6rem_1fr]">
              <dt className="text-muted-foreground">Current</dt>
              <dd
                className={cn(
                  "break-all",
                  one.currentHash && one.currentHash !== one.baselineHash && "text-modified",
                )}
              >
                {one.currentHash ?? "—"}
              </dd>
            </div>
            <div className="grid gap-1 sm:grid-cols-[6rem_1fr]">
              <dt className="text-muted-foreground">Algorithm</dt>
              <dd>{one.algorithm ?? "SHA-256"}</dd>
            </div>
            <div className="grid gap-1 sm:grid-cols-[6rem_1fr]">
              <dt className="text-muted-foreground">Entropy</dt>
              <dd>
                {one.entropy !== undefined
                  ? `${one.entropy.toFixed(2)} bits/byte at baseline`
                  : "—"}
              </dd>
            </div>
            <div className="grid gap-1 sm:grid-cols-[6rem_1fr]">
              <dt className="text-muted-foreground">Seal</dt>
              <dd className={one.sealOk ? "text-intact" : "text-missing"}>
                {one.sealOk
                  ? "ML-DSA-65 signature valid"
                  : "BROKEN – record changed outside Sentinel"}
              </dd>
            </div>
            <div className="grid gap-1 sm:grid-cols-[6rem_1fr]">
              <dt className="text-muted-foreground">Note</dt>
              <dd className="font-sans text-sm">{one.lastMessage}</dd>
            </div>
          </dl>
          {one.access === "needs-permission" && (
            <Button
              className="mt-4"
              size="sm"
              variant="caution"
              onClick={() => void s.grantAccess(one)}
            >
              Grant access
            </Button>
          )}
        </Panel>
      )}
    </div>
  );
}
