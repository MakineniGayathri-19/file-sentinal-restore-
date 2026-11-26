import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { EmptyState, LoadingPage, PageHeader, Panel, ResultLabel } from "@/components/sentinel/ui";
import { useConfirm } from "@/components/sentinel/confirm";
import { useSentinel } from "@/lib/sentinel/client";
import { formatTime } from "@/lib/sentinel/format";
import { downloadBlob } from "@/lib/sentinel/pickers";
import { LOG_RESULTS, LOG_TYPES } from "@/lib/sentinel/types";

export const Route = createFileRoute("/logs")({
  head: () => ({
    meta: [
      { title: "Activity Logs – Sentinel" },
      {
        name: "description",
        content:
          "Every registration, check, alert, backup and recovery, searchable and exportable as CSV.",
      },
      { property: "og:title", content: "Activity Logs – Sentinel" },
      {
        property: "og:description",
        content:
          "Every registration, check, alert, backup and recovery, searchable and exportable as CSV.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LogsPage,
});

const PAGE = 300;

function LogsPage() {
  const s = useSentinel();
  const confirm = useConfirm();
  const [type, setType] = useState("All");
  const [result, setResult] = useState("All");
  const [q, setQ] = useState("");
  const logs = s?.logs;
  const total = logs?.length ?? 0;

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return [...(logs ?? [])]
      .reverse()
      .filter(
        (e) =>
          (type === "All" || e.type === type) &&
          (result === "All" || e.result === result) &&
          (!query ||
            e.target.toLowerCase().includes(query) ||
            e.description.toLowerCase().includes(query)),
      );
  }, [logs, type, result, q]);

  if (!s) return <LoadingPage />;

  const exportCsv = () => {
    downloadBlob(
      new Blob([s.exportCsv([...filtered].reverse())], { type: "text/csv" }),
      "sentinel-log.csv",
    );
    toast.success("Exported", {
      description: `${filtered.length} entries saved as sentinel-log.csv`,
    });
  };

  const clear = async () => {
    const ok = await confirm({
      title: "Clear all logs?",
      description: "This permanently deletes the activity log. This cannot be undone.",
      confirmLabel: "Clear logs",
      tone: "danger",
    });
    if (ok && !(await s.clearLogs()))
      toast.error("Clear failed", { description: "The log could not be cleared." });
  };

  const latest = s.logs.at(-1);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity Logs"
        subtitle="Every registration, check, alert, backup and recovery is recorded"
        actions={
          <>
            <Button variant="subtle" onClick={exportCsv} disabled={!filtered.length}>
              <Download /> Export CSV
            </Button>
            <Button variant="danger" onClick={clear} disabled={!s.logs.length}>
              <Trash2 /> Clear Logs
            </Button>
          </>
        }
      />
      <Panel>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="bg-background sm:w-44" aria-label="Event type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All events</SelectItem>
              {LOG_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={result} onValueChange={setResult}>
            <SelectTrigger className="bg-background sm:w-40" aria-label="Result">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="All">All results</SelectItem>
              {LOG_RESULTS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search file or description"
            className="bg-background sm:max-w-xs"
          />
        </div>

        {filtered.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Description</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.slice(0, PAGE).map((e, i) => (
                  <TableRow key={e.id ?? `${e.time}-${i}`} className="border-border">
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {formatTime(e.time)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.type}</TableCell>
                    <TableCell>
                      <ResultLabel result={e.result} />
                    </TableCell>
                    <TableCell
                      className="max-w-[12rem] truncate text-sm font-medium"
                      title={e.target}
                    >
                      {e.target || "—"}
                    </TableCell>
                    <TableCell className="min-w-[16rem] text-sm text-muted-foreground">
                      {e.description}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="No matching entries" />
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          Showing {Math.min(filtered.length, PAGE)} of {filtered.length} matching ({total} total) ·
          stored in this browser
          {latest ? ` · latest: ${formatTime(latest.time)}` : ""}
          {filtered.length > PAGE ? " · export CSV for the full list" : ""}
        </p>
      </Panel>
    </div>
  );
}
