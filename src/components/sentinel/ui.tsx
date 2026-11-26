import type { ReactNode } from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import {
  STATUS_LABEL,
  type FileAccess,
  type FileStatus,
  type LogResult,
} from "@/lib/sentinel/types";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-6 md:flex-row md:items-end md:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

const statusVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium tracking-wide whitespace-nowrap",
  {
    variants: {
      status: {
        INTACT: "border-intact/30 bg-intact/10 text-intact",
        MODIFIED: "border-modified/30 bg-modified/10 text-modified",
        MISSING: "border-missing/30 bg-missing/10 text-missing",
        CHECK_ERROR: "border-check-error/30 bg-check-error/10 text-check-error",
        UNCHECKED: "border-unchecked/30 bg-unchecked/10 text-unchecked",
      },
    },
  },
);

const dotVariants = cva("size-1.5 rounded-full", {
  variants: {
    status: {
      INTACT: "bg-intact",
      MODIFIED: "bg-modified",
      MISSING: "bg-missing",
      CHECK_ERROR: "bg-check-error",
      UNCHECKED: "bg-unchecked",
    },
  },
});

export function StatusBadge({ status }: { status: FileStatus }) {
  return (
    <span className={statusVariants({ status })}>
      <span className={dotVariants({ status })} />
      {STATUS_LABEL[status]}
    </span>
  );
}

const resultVariants = cva("font-mono text-[11px] font-medium tracking-wide", {
  variants: {
    result: {
      SUCCESS: "text-intact",
      INFO: "text-info",
      WARNING: "text-modified",
      ERROR: "text-missing",
    },
  },
});

export function SuspiciousBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-missing/40 bg-missing/15 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-missing">
      POSSIBLE RANSOMWARE
    </span>
  );
}

export function ResultLabel({ result }: { result: LogResult }) {
  return <span className={resultVariants({ result })}>{result}</span>;
}

export function AccessLabel({ access }: { access: FileAccess }) {
  const text =
    access === "live" ? "Live link" : access === "snapshot" ? "Snapshot" : "Needs access";
  return (
    <span
      className={cn(
        "font-mono text-[11px]",
        access === "live" && "text-info",
        access === "snapshot" && "text-muted-foreground",
        access === "needs-permission" && "text-modified",
      )}
    >
      {text}
    </span>
  );
}

export function Panel({
  title,
  children,
  className,
  right,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <section className={cn("panel p-5", className)}>
      {(title || right) && (
        <div className="mb-4 flex items-center justify-between gap-2">
          {title && <h2 className="eyebrow">{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function LoadingPage() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="relative h-1 w-40 overflow-hidden rounded-full bg-card-alt">
        <div className="absolute inset-y-0 w-1/4 animate-scan rounded-full bg-primary" />
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

/** Stacked bar of file statuses (desktop IntegrityBar). */
export function IntegrityBar({ counts }: { counts: Record<FileStatus, number> }) {
  const order: FileStatus[] = ["INTACT", "MODIFIED", "MISSING", "CHECK_ERROR", "UNCHECKED"];
  const total = order.reduce((s, k) => s + counts[k], 0);
  const pct = total ? Math.round((counts.INTACT / total) * 100) : 0;
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-mono text-4xl font-semibold tabular-nums">
          {total ? `${pct}%` : "—"}
        </span>
        <span className="text-sm text-muted-foreground">
          {total ? "of protected files intact" : "No protected files yet"}
        </span>
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-card-alt">
        {total > 0 &&
          order.map((k) =>
            counts[k] ? (
              <div
                key={k}
                className={cn(dotVariants({ status: k }), "h-full rounded-none")}
                style={{ width: `${(counts[k] / total) * 100}%` }}
              />
            ) : null,
          )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {order.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={dotVariants({ status: k })} />
            {STATUS_LABEL[k]} <span className="font-mono text-foreground">{counts[k]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function statusCounts(statuses: FileStatus[]): Record<FileStatus, number> {
  const c: Record<FileStatus, number> = {
    UNCHECKED: 0,
    INTACT: 0,
    MODIFIED: 0,
    MISSING: 0,
    CHECK_ERROR: 0,
  };
  for (const s of statuses) c[s]++;
  return c;
}
