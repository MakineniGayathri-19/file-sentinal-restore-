import type { FileHandleLike } from "./types";

type PickerWindow = Window & {
  showOpenFilePicker?: (o?: { multiple?: boolean }) => Promise<FileHandleLike[]>;
  showSaveFilePicker?: (o?: { suggestedName?: string }) => Promise<FileHandleLike>;
};

export const isEmbedded = () => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
};

/** True when this browser can keep live links to files (Chrome, Edge, Opera, open in their own tab). */
export function supportsLiveFiles(): boolean {
  return typeof window !== "undefined" && "showOpenFilePicker" in window && !isEmbedded();
}

function errName(e: unknown) {
  return e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
}

/** Classic file input; gives one-time snapshots. */
export function pickSnapshots(multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export type Picked = { handles: FileHandleLike[]; files: File[] };

/** Opens the best available file picker. Returns empty lists if the user cancels. */
export async function pickFilesToProtect(): Promise<Picked> {
  const w = window as PickerWindow;
  if (w.showOpenFilePicker && !isEmbedded()) {
    try {
      return { handles: await w.showOpenFilePicker({ multiple: true }), files: [] };
    } catch (e) {
      if (errName(e) === "AbortError") return { handles: [], files: [] };
      // SecurityError etc: fall through to the classic picker
    }
  }
  return { handles: [], files: await pickSnapshots(true) };
}

/** Collects handles (live links) from a drop event, falling back to snapshots. Must be called synchronously in the handler. */
export async function fromDrop(dt: DataTransfer): Promise<Picked> {
  const items = Array.from(dt.items).filter((i) => i.kind === "file");
  type HandleItem = DataTransferItem & {
    getAsFileSystemHandle?: () => Promise<FileHandleLike | null>;
  };
  const handlePromises = items.map((i) => (i as HandleItem).getAsFileSystemHandle?.() ?? null);
  const fallbackFiles = items.map((i) => i.getAsFile());
  const handles: FileHandleLike[] = [];
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const hp = handlePromises[i];
    let h: FileHandleLike | null = null;
    if (hp) {
      try {
        h = await hp;
      } catch {
        h = null;
      }
    }
    if (h) handles.push(h);
    else {
      const f = fallbackFiles[i];
      if (f) files.push(f);
    }
  }
  return { handles, files };
}

/** Asks where to save a copy. Returns a handle, "download" when only a download is possible, or null when cancelled. */
export async function pickSaveTarget(
  suggestedName: string,
): Promise<FileHandleLike | "download" | null> {
  const w = window as PickerWindow;
  if (w.showSaveFilePicker && !isEmbedded()) {
    try {
      return await w.showSaveFilePicker({ suggestedName });
    } catch (e) {
      if (errName(e) === "AbortError") return null;
    }
  }
  return "download";
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
