import { toast } from "sonner";
import type { Sentinel } from "@/lib/sentinel/engine";
import type { Picked } from "@/lib/sentinel/pickers";

/** Registers everything picked or dropped and reports one summary toast. */
export async function registerPicked(s: Sentinel, picked: Picked): Promise<void> {
  const inputs = [
    ...picked.handles.map((handle) => ({ handle })),
    ...picked.files.map((file) => ({ file })),
  ];
  if (!inputs.length) return;
  let ok = 0;
  const problems: string[] = [];
  for (const input of inputs) {
    try {
      await s.register(input);
      ok++;
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (ok && !problems.length)
    toast.success("Protection enabled", {
      description: `${ok} file(s) registered with initial backup`,
    });
  else if (ok)
    toast.warning(`${ok} registered, some skipped`, { description: problems.join("\n") });
  else toast.error("Nothing registered", { description: problems.join("\n") });
  if (picked.files.length && !picked.handles.length)
    toast.info("Snapshot mode", {
      description:
        "This browser only gave Sentinel a one-time copy, so these files are checked when you choose them again.",
    });
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
