import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";

export interface ConfirmOptions {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger" | "caution";
}

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    resolver.current?.(false);
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpts(null);
  };

  const variant =
    opts?.tone === "danger" ? "destructive" : opts?.tone === "caution" ? "caution" : "default";

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={!!opts} onOpenChange={(o) => !o && close(false)}>
        <AlertDialogContent className="border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 whitespace-pre-line text-sm text-muted-foreground">
                {opts?.description}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className={buttonVariants({ variant: "subtle" })}
              onClick={() => close(false)}
            >
              {opts?.cancelLabel ?? "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant })} onClick={() => close(true)}>
              {opts?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);
