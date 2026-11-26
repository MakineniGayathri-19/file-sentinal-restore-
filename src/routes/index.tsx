import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Play, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  IntegrityBar,
  LoadingPage,
  PageHeader,
  Panel,
  ResultLabel,
  statusCounts,
} from "@/components/sentinel/ui";
import { useSentinel } from "@/lib/sentinel/client";
import { formatTime } from "@/lib/sentinel/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard – Sentinel" },
      {
        name: "description",
        content: "Real-time overview of your protected files, alerts and backups.",
      },
      { property: "og:title", content: "Dashboard – Sentinel" },
      {
        property: "og:description",
        content: "Real-time overview of your protected files, alerts and backups.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "intact" | "modified" | "missing" | "info";
}) {
  return (
    <div className="panel p-4">
      <p className="eyebrow">{label}</p>
      <p
        className={cn(
          "mt-2 font-mono text-3xl font-semibold tabular-nums",
          tone === "intact" && "text-intact",
          tone === "modified" && "text-modified",
          tone === "missing" && "text-missing",
          tone === "info" && "text-info",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function Dashboard() {
  const s = useSentinel();
  const [busy, setBusy] = useState(false);
  if (!s) return <LoadingPage />;

  const files = s.active();
  const counts = statusCounts(files.map((f) => f.status));
  const recent = [...s.logs].reverse().slice(0, 8);
  const suspicious = files.filter((f) => f.suspicious).length;

  const verifyAll = async () => {
    setBusy(true);
    try {
      const c = await s.verifyAll();
      const bad = c.MODIFIED + c.MISSING;
      if (bad)
        toast.warning("Verification finished", { description: `${bad} file(s) need attention` });
      else toast.success("Verification finished", { description: "All files are intact" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle="Real-time overview of your protected files"
        actions={
          <>
            <Button variant="subtle" onClick={verifyAll} disabled={busy || !files.length}>
              <RefreshCw className={cn(busy && "animate-spin")} /> Verify All Now
            </Button>
            {s.monitorRunning ? (
              <Button variant="danger" onClick={() => s.stopMonitoring()}>
                <Square /> Stop Monitoring
              </Button>
            ) : (
              <Button onClick={() => s.startMonitoring()}>
                <Play /> Start Monitoring
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Protected files" value={files.length} />
        <Stat label="Intact" value={counts.INTACT} tone="intact" />
        <Stat label="Modified" value={counts.MODIFIED} tone="modified" />
        <Stat label="Missing" value={counts.MISSING} tone="missing" />
        <Stat label="Backups" value={s.activeBackupCount()} tone="info" />
        <Stat
          label="Monitoring"
          value={s.monitorRunning ? "ACTIVE" : "OFF"}
          {...(s.monitorRunning ? { tone: "intact" as const } : {})}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="panel flex items-center justify-between gap-3 p-4">
          <div>
            <p className="eyebrow">Registry seal</p>
            <p
              className={cn(
                "mt-1 font-mono text-sm font-semibold",
                s.sealProblems() ? "text-missing" : "text-intact",
              )}
            >
              {s.sealProblems() ? `${s.sealProblems()} RECORD(S) BROKEN` : "VALID"}
            </p>
          </div>
          <span className="text-right font-mono text-[11px] text-muted-foreground">
            ML-DSA-65
            <br />
            post-quantum
          </span>
        </div>
        <div className="panel flex items-center justify-between gap-3 p-4">
          <div>
            <p className="eyebrow">Ransomware watch</p>
            <p
              className={cn(
                "mt-1 font-mono text-sm font-semibold",
                suspicious ? "text-missing" : "text-intact",
              )}
            >
              {suspicious ? `${suspicious} FILE(S) LOOK ENCRYPTED` : "NO SIGNS"}
            </p>
          </div>
          <span className="text-right font-mono text-[11px] text-muted-foreground">
            entropy
            <br />
            analysis
          </span>
        </div>
        <div className="panel flex items-center justify-between gap-3 p-4">
          <div>
            <p className="eyebrow">New files use</p>
            <p className="mt-1 font-mono text-sm font-semibold text-info">
              {s.settings.hashAlgorithm}
            </p>
          </div>
          <Link to="/settings" className="text-xs text-primary hover:underline">
            Change
          </Link>
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <Panel title="Integrity overview" className="lg:col-span-2">
          <IntegrityBar counts={counts} />
          {!files.length && (
            <p className="mt-6 text-sm text-muted-foreground">
              Start by adding files on{" "}
              <Link to="/files" className="text-primary underline-offset-4 hover:underline">
                Protected Files
              </Link>
              .
            </p>
          )}
        </Panel>
        <Panel
          title="Recent security events"
          className="lg:col-span-3"
          right={
            <Link to="/logs" className="text-xs text-primary hover:underline">
              View all
            </Link>
          }
        >
          {recent.length ? (
            <ul className="divide-y divide-border">
              {recent.map((e, i) => (
                <li
                  key={e.id ?? `${e.time}-${i}`}
                  className="flex items-start gap-3 py-2.5 text-sm"
                >
                  <span className="w-[4.5rem] shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground">
                    {formatTime(e.time).slice(11)}
                  </span>
                  <span className="w-16 shrink-0 pt-0.5">
                    <ResultLabel result={e.result} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-[11px] text-muted-foreground">{e.type}</span>{" "}
                    {e.target && <span className="font-medium">{e.target} </span>}
                    <span className="text-muted-foreground">{e.description}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No events yet.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}
