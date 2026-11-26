import { useMemo } from "react";
import { diffLines } from "diff";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const MAX_LINES = 3000;

export interface DiffData {
  title: string;
  backupLabel: string;
  backupText: string;
  currentText: string;
}

/** Line-by-line comparison (Myers diff) of a backup version and the current file. */
export function DiffDialog({ data, onClose }: { data: DiffData | null; onClose: () => void }) {
  const rows = useMemo(() => {
    if (!data)
      return {
        lines: [] as {
          kind: "add" | "del" | "same";
          text: string;
          a: number | null;
          b: number | null;
        }[],
        added: 0,
        removed: 0,
        truncated: false,
      };
    const parts = diffLines(data.backupText, data.currentText);
    const lines: {
      kind: "add" | "del" | "same";
      text: string;
      a: number | null;
      b: number | null;
    }[] = [];
    let a = 1;
    let b = 1;
    let added = 0;
    let removed = 0;
    for (const p of parts) {
      const ls = p.value.replace(/\n$/, "").split("\n");
      for (const text of ls) {
        if (p.added) {
          lines.push({ kind: "add", text, a: null, b: b++ });
          added++;
        } else if (p.removed) {
          lines.push({ kind: "del", text, a: a++, b: null });
          removed++;
        } else lines.push({ kind: "same", text, a: a++, b: b++ });
      }
    }
    return {
      lines: lines.slice(0, MAX_LINES),
      added,
      removed,
      truncated: lines.length > MAX_LINES,
    };
  }, [data]);

  return (
    <Dialog open={!!data} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-hidden border-border bg-card">
        <DialogHeader>
          <DialogTitle>{data?.title}</DialogTitle>
          <DialogDescription>
            {data?.backupLabel} → current file ·{" "}
            <span className="font-mono text-intact">+{rows.added}</span>{" "}
            <span className="font-mono text-missing">−{rows.removed}</span>
            {rows.added + rows.removed === 0 && " · no differences"}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[62vh] overflow-auto rounded-md border border-border bg-background font-mono text-xs">
          {rows.lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                "grid grid-cols-[3rem_3rem_1.25rem_1fr]",
                l.kind === "add" && "bg-intact/10 text-intact",
                l.kind === "del" && "bg-missing/10 text-missing",
              )}
            >
              <span className="select-none px-2 text-right text-muted-foreground">{l.a ?? ""}</span>
              <span className="select-none px-2 text-right text-muted-foreground">{l.b ?? ""}</span>
              <span className="select-none">
                {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
              </span>
              <span className="whitespace-pre-wrap break-all pr-2">{l.text || " "}</span>
            </div>
          ))}
          {rows.truncated && (
            <p className="p-3 text-muted-foreground">Showing the first {MAX_LINES} lines.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
