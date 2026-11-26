import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { HardDrive, Save } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HASH_ALGORITHMS, type HashAlgorithm } from "@/lib/sentinel/hash";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { LoadingPage, PageHeader, Panel } from "@/components/sentinel/ui";
import { useSentinel } from "@/lib/sentinel/client";
import { clampKeepVersions, clampScanInterval, formatSize } from "@/lib/sentinel/format";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings / About – Sentinel" },
      {
        name: "description",
        content: "Preferences, storage, security notes and information about Sentinel.",
      },
      { property: "og:title", content: "Settings / About – Sentinel" },
      {
        property: "og:description",
        content: "Preferences, storage, security notes and information about Sentinel.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const s = useSentinel();
  const [interval, setIntervalText] = useState("20");
  const [autoStart, setAutoStart] = useState(false);
  const [notify, setNotify] = useState(true);
  const [algo, setAlgo] = useState<HashAlgorithm>("SHA-256");
  const [keep, setKeep] = useState("0");
  const [system, setSystem] = useState(false);
  const [storage, setStorage] = useState<{
    usage: number;
    quota: number;
    persisted: boolean;
  } | null>(null);

  useEffect(() => {
    if (!s) return;
    setIntervalText(String(s.settings.scanIntervalSeconds));
    setAutoStart(s.settings.autoStartMonitoring);
    setNotify(s.settings.notifications);
    setAlgo(s.settings.hashAlgorithm);
    setKeep(String(s.settings.keepVersions));
    setSystem(s.settings.systemNotifications);
  }, [s]);

  const refreshStorage = async () => {
    if (!navigator.storage?.estimate) return;
    const [e, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted?.() ?? Promise.resolve(false),
    ]);
    setStorage({ usage: e.usage ?? 0, quota: e.quota ?? 0, persisted });
  };
  useEffect(() => {
    void refreshStorage();
  }, []);

  if (!s) return <LoadingPage />;

  const save = async () => {
    try {
      await s.saveSettings({
        scanIntervalSeconds: clampScanInterval(Number(interval)),
        autoStartMonitoring: autoStart,
        notifications: notify,
        hashAlgorithm: algo,
        keepVersions: clampKeepVersions(Number(keep)),
        systemNotifications: system,
      });
      setIntervalText(String(s.settings.scanIntervalSeconds));
      setKeep(String(s.settings.keepVersions));
      toast.success("Preferences saved", { description: "Stored in this browser" });
    } catch (e) {
      toast.error("Save failed", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const toggleSystem = async (on: boolean) => {
    if (!on) return setSystem(false);
    if (!("Notification" in window))
      return void toast.error("Not supported", {
        description: "This browser can't show system notifications.",
      });
    const p =
      Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (p === "granted") setSystem(true);
    else
      toast.warning("Notifications blocked", {
        description: "Allow notifications for this site in your browser settings.",
      });
  };

  const persist = async () => {
    const ok = (await navigator.storage?.persist?.()) ?? false;
    await refreshStorage();
    if (ok)
      toast.success("Storage protected", {
        description: "The browser won't clear Sentinel's data to free up space.",
      });
    else
      toast.warning("Not granted", {
        description:
          "The browser decided not to protect storage right now. Try again after using Sentinel a bit more.",
      });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings / About"
        subtitle="Preferences, security notes and project information"
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Preferences">
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="interval" className="text-sm">
                Safety scan interval (seconds, 0 = off)
              </Label>
              <Input
                id="interval"
                type="number"
                min={0}
                max={3600}
                value={interval}
                onChange={(e) => setIntervalText(e.target.value)}
                className="w-24 bg-background font-mono"
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="autostart" className="text-sm">
                Start monitoring automatically when Sentinel opens
              </Label>
              <Switch id="autostart" checked={autoStart} onCheckedChange={setAutoStart} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="notify" className="text-sm">
                Show pop-up notifications for security alerts
              </Label>
              <Switch id="notify" checked={notify} onCheckedChange={setNotify} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="system" className="text-sm">
                Also show system notifications (outside the browser)
              </Label>
              <Switch id="system" checked={system} onCheckedChange={(v) => void toggleSystem(v)} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label className="text-sm">
                Fingerprint algorithm for new files
                <span className="block text-xs font-normal text-muted-foreground">
                  Existing files keep the algorithm they were added with.
                </span>
              </Label>
              <Select value={algo} onValueChange={(v) => setAlgo(v as HashAlgorithm)}>
                <SelectTrigger
                  className="w-36 bg-background font-mono"
                  aria-label="Fingerprint algorithm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HASH_ALGORITHMS.map((a) => (
                    <SelectItem key={a} value={a} className="font-mono">
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="keep" className="text-sm">
                Keep newest backup versions per file (0 = all)
                <span className="block text-xs font-normal text-muted-foreground">
                  The version matching the baseline is always kept.
                </span>
              </Label>
              <Input
                id="keep"
                type="number"
                min={0}
                max={999}
                value={keep}
                onChange={(e) => setKeep(e.target.value)}
                className="w-24 bg-background font-mono"
              />
            </div>
            <Button onClick={save}>
              <Save /> Save Preferences
            </Button>
          </div>
        </Panel>

        <Panel title="Storage">
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Fingerprints, backups, logs and settings are stored in this browser on this computer.
              Nothing is uploaded.
            </p>
            {storage && (
              <dl className="grid grid-cols-2 gap-2 font-mono text-xs">
                <dt className="text-muted-foreground">Used</dt>
                <dd>{formatSize(storage.usage)}</dd>
                <dt className="text-muted-foreground">Available</dt>
                <dd>{formatSize(storage.quota)}</dd>
                <dt className="text-muted-foreground">Protected from clean-up</dt>
                <dd className={storage.persisted ? "text-intact" : "text-modified"}>
                  {storage.persisted ? "yes" : "no"}
                </dd>
              </dl>
            )}
            {!storage?.persisted && (
              <Button variant="subtle" size="sm" onClick={persist}>
                <HardDrive /> Keep data safe from clean-up
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Clearing this site's data in your browser deletes Sentinel's backups and logs.
            </p>
          </div>
        </Panel>
      </div>

      <Panel title="Security algorithms">
        <div className="grid gap-4 text-sm md:grid-cols-3">
          <div>
            <p className="font-medium">ML-DSA-65 registry seal</p>
            <p className="mt-1 text-muted-foreground">
              Every baseline and backup record is signed with the NIST post-quantum signature
              standard (FIPS 204) – the same algorithm added to Java 24. Records changed outside
              Sentinel are flagged at start-up.
            </p>
            <p className="mt-2 font-mono text-xs">
              Key fingerprint <span className="text-info">{s.sealFingerprint}</span>
            </p>
            <p
              className={`mt-1 font-mono text-xs ${s.sealProblems() ? "text-missing" : "text-intact"}`}
            >
              {s.sealProblems() ? `${s.sealProblems()} record(s) broken` : "All records valid"}
            </p>
          </div>
          <div>
            <p className="font-medium">SHA-256 · SHA3-256 · BLAKE3</p>
            <p className="mt-1 text-muted-foreground">
              Choose the fingerprint for new files: SHA-256 (classic, hardware-accelerated),
              SHA3-256 (Keccak, FIPS 202) or BLAKE3 (modern and very fast in software).
            </p>
          </div>
          <div>
            <p className="font-medium">Ransomware watch</p>
            <p className="mt-1 text-muted-foreground">
              When a file changes, Sentinel measures its Shannon entropy. Ordinary content that
              suddenly looks random (above 7.5 bits per byte) is the typical sign of encryption by
              ransomware and raises a red alert.
            </p>
          </div>
        </div>
      </Panel>

      <Panel title="About">
        <div className="space-y-4 text-sm leading-relaxed">
          <div>
            <p className="font-semibold">
              Sentinel – Intelligent File Integrity Monitoring and Recovery System
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              Version 2.0 (web) · SHA-256 / SHA3-256 / BLAKE3 · ML-DSA-65 · File System Access ·
              IndexedDB
            </p>
          </div>
          <div>
            <p className="eyebrow mb-1">What Sentinel does</p>
            <p className="text-muted-foreground">
              Records a SHA-256 baseline of each protected file, re-checks it on demand and
              automatically (live file links + periodic scan), keeps versioned local backups, and
              restores a file only after verifying the backup's hash.
            </p>
          </div>
          <div>
            <p className="eyebrow mb-1">Honest security notes</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>
                A hash detects CHANGE; it does not prove WHO changed a file. The ML-DSA seal proves
                Sentinel's own records weren't edited, but its key lives in the same browser, so
                someone with full access to this browser profile could re-sign them.
              </li>
              <li>
                The ransomware watch is a heuristic: it can miss partial encryption and can't tell
                compressed files from encrypted ones.
              </li>
              <li>
                Backups and the registry live in this browser's storage. Anyone using the same
                browser profile can change them together, so local backups are NOT tamper-proof. For
                real protection keep copies on separate, access-controlled storage.
              </li>
              <li>
                Monitoring only runs while this tab is open, and browsers slow down background tabs;
                the safety scan reduces, but cannot remove, that gap. Changes made while Sentinel is
                closed are caught at the next start.
              </li>
              <li>
                Live monitoring and in-place restore need Chrome or Edge; other browsers use
                snapshot mode. Folders are refused, and files are never opened or run.
              </li>
              <li>This is a college-level educational tool, not an enterprise security product.</li>
            </ul>
          </div>
        </div>
      </Panel>
    </div>
  );
}
