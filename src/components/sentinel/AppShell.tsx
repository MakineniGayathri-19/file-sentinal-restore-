import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArchiveRestore,
  ExternalLink,
  FileLock2,
  LayoutDashboard,
  Radar,
  ScrollText,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSentinel } from "@/lib/sentinel/client";
import { isEmbedded } from "@/lib/sentinel/pickers";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/files", label: "Protected Files", icon: FileLock2 },
  { to: "/monitoring", label: "File Monitoring", icon: Radar },
  { to: "/backups", label: "Backup & Recovery", icon: ArchiveRestore },
  { to: "/logs", label: "Activity Logs", icon: ScrollText },
  { to: "/settings", label: "Settings / About", icon: Settings },
] as const;

function MonitorStatus({ on }: { on: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span
        className={cn("size-2 rounded-full", on ? "animate-pulse-dot bg-intact" : "bg-unchecked")}
      />
      <span className={on ? "text-intact" : "text-muted-foreground"}>
        {on ? "Monitoring active" : "Monitoring off"}
      </span>
    </span>
  );
}

function Banners() {
  const s = useSentinel();
  const [env, setEnv] = useState<{ embedded: boolean; live: boolean } | null>(null);
  useEffect(() => setEnv({ embedded: isEmbedded(), live: "showOpenFilePicker" in window }), []);
  const needs = s?.active().filter((f) => f.access === "needs-permission") ?? [];
  const sealProblems = s?.sealProblems() ?? 0;

  return (
    <div className="space-y-2">
      {env?.embedded && (
        <div className="flex flex-col gap-3 rounded-lg border border-info/30 bg-info/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p>
            <span className="font-medium text-info">Open Sentinel in its own tab</span>{" "}
            <span className="text-muted-foreground">
              to keep live links to your files, watch them and restore them in place.
            </span>
          </p>
          <Button
            size="sm"
            variant="subtle"
            onClick={() => window.open(window.location.href, "_blank", "noopener")}
          >
            <ExternalLink /> Open in new tab
          </Button>
        </div>
      )}
      {env && !env.embedded && !env.live && (
        <div className="rounded-lg border border-modified/30 bg-modified/10 px-4 py-3 text-sm">
          <span className="font-medium text-modified">Snapshot mode.</span>{" "}
          <span className="text-muted-foreground">
            This browser can't keep live links to files, so you'll choose a file again to check it.
            Use Chrome or Edge for automatic monitoring.
          </span>
        </div>
      )}
      {sealProblems > 0 && (
        <div className="rounded-lg border border-missing/40 bg-missing/10 px-4 py-3 text-sm">
          <span className="font-medium text-missing">
            {sealProblems} record(s) failed the ML-DSA seal check.
          </span>{" "}
          <span className="text-muted-foreground">
            Sentinel's stored data was changed outside the app. Affected files show CHECK ERROR;
            re-accept their baseline after confirming the content.
          </span>
        </div>
      )}
      {s && needs.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-modified/30 bg-modified/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p>
            <span className="font-medium text-modified">
              {needs.length} protected file(s) need access again.
            </span>{" "}
            <span className="text-muted-foreground">
              Your browser asks once per visit unless you choose "Allow on every visit".
            </span>
          </p>
          <Button
            size="sm"
            variant="caution"
            onClick={async () => {
              const first = needs[0];
              if (first && !(await s.grantAccess(first)))
                toast.error("Access not granted", { description: first.name });
            }}
          >
            Grant access to {needs[0]?.name}
          </Button>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const s = useSentinel();
  const running = s?.monitorRunning ?? false;

  // Pop-up alerts for monitor detections (desktop "Toast").
  useEffect(() => {
    if (!s) return;
    return s.onMonitorEvent((e) => {
      if (
        s.settings.systemNotifications &&
        "Notification" in window &&
        Notification.permission === "granted" &&
        e.current !== "INTACT"
      ) {
        try {
          new Notification(
            e.suspicious
              ? "Sentinel: possible ransomware"
              : `Sentinel: file ${e.current === "MISSING" ? "deleted" : "changed"}`,
            {
              body: e.fileName,
              tag: `sentinel-${e.fileId}`,
            },
          );
        } catch {
          /* some browsers only allow notifications from a service worker */
        }
      }
      if (!s.settings.notifications) return;
      if (e.suspicious)
        toast.error("Possible ransomware", {
          description: `${e.fileName} changed and now looks encrypted. Restore it from a backup.`,
          duration: 15000,
        });
      else if (e.current === "MODIFIED")
        toast.warning("File modified", {
          description: `${e.fileName} no longer matches its SHA-256 baseline`,
        });
      else if (e.current === "MISSING")
        toast.error("File deleted", { description: `${e.fileName} is missing` });
      else if (e.current === "INTACT")
        toast.success("File intact again", { description: e.fileName });
      else if (e.current === "CHECK_ERROR") toast.error("Check error", { description: e.fileName });
    });
  }, [s]);

  // Closing the tab stops monitoring, like quitting the desktop app.
  useEffect(() => {
    if (!running) return;
    const h = (ev: BeforeUnloadEvent) => {
      ev.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [running]);

  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-sidebar-border bg-sidebar md:sticky md:top-0 md:h-screen md:w-60 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-3 px-5 py-4 md:py-6">
          <Link to="/" className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg border border-primary/40 bg-primary/15 text-primary">
              <ShieldCheck className="size-5" />
            </span>
            <span>
              <span className="block text-base font-bold tracking-[0.18em]">SENTINEL</span>
              <span className="block text-[11px] text-muted-foreground">Integrity Monitor</span>
            </span>
          </Link>
          <span className="md:hidden">
            <MonitorStatus on={running} />
          </span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible md:pb-0">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: to === "/" }}
              className="group relative flex shrink-0 items-center gap-3 rounded-md px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
              activeProps={{ className: "bg-sidebar-accent text-foreground" }}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto hidden px-5 py-5 md:block">
          <MonitorStatus on={running} />
        </div>
      </aside>
      <main className="console-grid min-w-0 flex-1">
        <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-8 md:py-8">
          <Banners />
          {children}
        </div>
      </main>
    </div>
  );
}
