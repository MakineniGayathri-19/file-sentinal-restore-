import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, LoadingPage, PageHeader, Panel, StatusBadge } from "@/components/sentinel/ui";
import { useSentinel } from "@/lib/sentinel/client";
import { clampScanInterval, formatTime } from "@/lib/sentinel/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/monitoring")({
  head: () => ({
    meta: [
      { title: "File Monitoring – Sentinel" },
      {
        name: "description",
        content:
          "Automatic change detection with SHA-256 re-verification and a periodic safety scan.",
      },
      { property: "og:title", content: "File Monitoring – Sentinel" },
      {
        property: "og:description",
        content:
          "Automatic change detection with SHA-256 re-verification and a periodic safety scan.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MonitoringPage,
});

function MonitoringPage() {
  const s = useSentinel();
  const [interval, setIntervalText] = useState("");
  useEffect(() => {
    if (s) setIntervalText(String(s.settings.scanIntervalSeconds));
  }, [s]);
  if (!s) return <LoadingPage />;

  const on = s.monitorRunning;
  const watched = s.watchedFiles();
  const notWatched = s.active().filter((f) => !watched.includes(f));

  const saveInterval = async () => {
    const n = clampScanInterval(Number(interval));
    setIntervalText(String(n));
    if (n === s.settings.scanIntervalSeconds) return;
    await s.saveSettings({ ...s.settings, scanIntervalSeconds: n });
    toast.success("Safety scan updated", { description: n ? `Every ${n} seconds` : "Turned off" });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="File Monitoring"
        subtitle="Automatic detection with live file links + SHA-256 re-verification"
      />

      <section
        className={cn(
          "panel flex flex-col gap-5 p-6 md:flex-row md:items-center md:justify-between",
          on && "border-intact/40 shadow-glow",
        )}
      >
        <div className="flex items-center gap-4">
          <span
            className={cn(
              "size-3 rounded-full",
              on ? "animate-pulse-dot bg-intact" : "bg-unchecked",
            )}
          />
          <div>
            <p
              className={cn(
                "font-mono text-lg font-semibold tracking-wider",
                on ? "text-intact" : "text-muted-foreground",
              )}
            >
              {on ? "MONITORING ACTIVE" : "MONITORING OFF"}
            </p>
            <p className="text-sm text-muted-foreground">
              {on
                ? `Watching ${watched.length} protected file(s)`
                : "Press Start to watch protected files for changes"}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Safety scan every
            <Input
              type="number"
              min={0}
              max={3600}
              value={interval}
              onChange={(e) => setIntervalText(e.target.value)}
              onBlur={saveInterval}
              onKeyDown={(e) => e.key === "Enter" && void saveInterval()}
              className="h-8 w-20 bg-background font-mono"
            />
            seconds (0 = off)
          </label>
          {on ? (
            <Button variant="danger" onClick={() => s.stopMonitoring()}>
              <Square /> Stop Monitoring
            </Button>
          ) : (
            <Button onClick={() => s.startMonitoring()}>
              <Play /> Start Monitoring
            </Button>
          )}
        </div>
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <Panel title="Watched files">
          {watched.length ? (
            <ul className="space-y-2 text-sm">
              {watched.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2">
                  <span className="truncate" title={f.name}>
                    {f.name}
                  </span>
                  <StatusBadge status={f.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">(no live files – add files first)</p>
          )}
          {notWatched.length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <p className="eyebrow mb-2">Not watched</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {notWatched.map((f) => (
                  <li key={f.id} className="truncate">
                    {f.name} –{" "}
                    {f.access === "snapshot" ? "snapshot, check manually" : "needs access"}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <Panel title="Live detections (this session)" className="lg:col-span-2">
          {s.detections.length ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead>Time</TableHead>
                    <TableHead>File</TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead>Status change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.detections.map((d, i) => (
                    <TableRow key={`${d.time}-${i}`} className="border-border">
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {formatTime(d.time)}
                      </TableCell>
                      <TableCell className="font-medium">{d.fileName}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {d.trigger}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-2">
                          <StatusBadge status={d.previous} /> → <StatusBadge status={d.current} />
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Nothing detected yet">
              {on
                ? "Edit or delete a protected file to see it here."
                : "Start monitoring to see changes as they happen."}
            </EmptyState>
          )}
        </Panel>
      </div>

      <p className="text-xs text-muted-foreground">
        How it works: while this tab is open, Sentinel checks each file's size and modified time
        about once a second, waits until a change settles, then re-computes its SHA-256. The safety
        scan re-hashes everything on a timer to catch anything missed. Browsers slow down background
        tabs, so detection can take longer when Sentinel isn't the visible tab. Closing the tab
        stops monitoring.
      </p>
    </div>
  );
}
