import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { ChevronRightIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { Fragment, type RefObject, useRef } from "react";

import { environmentThreadShells } from "~/state/threads";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";
import {
  countRestartingThreads,
  type RestartingMachine,
  type RestartingThreadCounts,
  type UpdateEverythingRow,
} from "./updateEverything.logic";

// Keyed by "continue" or "stop", then the machines' environment ids, one per line.
const restartingThreadCountsAtom = Atom.family((key: string) =>
  Atom.make((get): RestartingThreadCounts => {
    let running = 0;
    let pacedOrStalled = 0;
    const [mode, ...environmentIds] = key.split("\n");
    for (const id of environmentIds) {
      if (id === "") continue;
      const counts = countRestartingThreads(
        get(environmentThreadShells.environmentThreadsAtom(EnvironmentId.make(id))),
        mode === "continue",
      );
      running += counts.running;
      pacedOrStalled += counts.pacedOrStalled;
    }
    return { running, pacedOrStalled };
  }).pipe(Atom.withLabel(`update-everything-running-threads:${key}`)),
);

interface UpdateEverythingDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly version: string | null;
  readonly providerCount: number;
  readonly rows: ReadonlyArray<UpdateEverythingRow>;
  readonly restarts: ReadonlyArray<RestartingMachine>;
  readonly onConfirm: () => void;
  /** Overrides the "Update N machines?" title, for an update-track switch. */
  readonly title?: string;
  readonly confirmLabel?: string;
  readonly notes?: ReadonlyArray<string>;
  /** Shown in place of running-thread counts; disables the confirm button. */
  readonly disabledReason?: string | null;
  /** The confirmed work is starting; it cannot be cancelled from here. */
  readonly busy?: boolean;
  /** Machines are still looking for provider updates, so more rows can appear. */
  readonly checking?: boolean;
}

type UpdateEverythingDialogContentProps = Omit<
  UpdateEverythingDialogProps,
  "open" | "onOpenChange"
> & {
  readonly cancelRef: RefObject<HTMLButtonElement | null>;
};

export function UpdateEverythingDialog({
  open,
  onOpenChange,
  ...content
}: UpdateEverythingDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* Refocusing the trigger after a pointer close shows its focus ring and opens its tooltip. */}
      <AlertDialogPopup
        className="sm:max-w-xl"
        initialFocus={cancelRef}
        finalFocus={(closeType) => closeType === "keyboard"}
      >
        <UpdateEverythingDialogContent {...content} cancelRef={cancelRef} />
      </AlertDialogPopup>
    </AlertDialog>
  );
}

const APP_LABELS = {
  "this-app": msg("This app"),
  server: msg("Server"),
  "desktop-app": msg("Desktop app"),
} as const;

function UpdateEverythingDialogContent({
  version,
  providerCount,
  rows,
  restarts,
  onConfirm,
  cancelRef,
  title,
  confirmLabel,
  notes = [],
  disabledReason = null,
  busy = false,
  checking = false,
}: UpdateEverythingDialogContentProps) {
  const gt = useGT();
  const m = useMessages();
  const stoppedCounts = useAtomValue(
    restartingThreadCountsAtom(
      [
        "stop",
        ...restarts
          .filter((machine) => !machine.continuesThreads)
          .map((machine) => machine.environmentId),
      ].join("\n"),
    ),
  );
  const continuingCounts = useAtomValue(
    restartingThreadCountsAtom(
      [
        "continue",
        ...restarts
          .filter((machine) => machine.continuesThreads)
          .map((machine) => machine.environmentId),
      ].join("\n"),
    ),
  );
  const stopped = stoppedCounts.running;
  const continuing = continuingCounts.running;
  const running = stopped + continuing;
  const pacedOrStalled = stoppedCounts.pacedOrStalled + continuingCounts.pacedOrStalled;
  const restarting = new Set(restarts.map((machine) => machine.environmentId));
  const updating = rows.filter((row) => row.app !== null || row.providers.length > 0);
  const skipped = rows.filter((row) => row.skipped !== null);

  return (
    <>
      <AlertDialogHeader className="shrink-0">
        <AlertDialogTitle>
          {title ??
            gt("{count, plural, one {Update {count} machine?} other {Update {count} machines?}}", {
              count: updating.length,
            })}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {version !== null ? (
            <>
              T3 Code <span className="font-mono text-xs">{version}</span>
            </>
          ) : null}
          {version !== null && providerCount > 0 ? " · " : null}
          {providerCount > 0
            ? gt(
                "{count, plural, one {{count} provider update} other {{count} provider updates}}",
                { count: providerCount },
              )
            : null}
          {checking
            ? `${version !== null || providerCount > 0 ? " · " : ""}${gt("Checking for more…")}`
            : null}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ScrollArea scrollFade>
        <div className="flex flex-col gap-3 px-6 pb-4">
          {notes.map((note) => (
            <p key={note} className="text-muted-foreground text-sm">
              {note}
            </p>
          ))}
          {/* Machine names truncate first. Provider lists wrap between names, never inside one. */}
          <div
            role="table"
            className="grid grid-cols-[minmax(4rem,max-content)_max-content_minmax(min-content,1fr)_max-content] gap-x-4 text-sm"
          >
            <div
              role="row"
              className="col-span-full grid grid-cols-subgrid border-b pb-1.5 text-muted-foreground text-xs"
            >
              <span role="columnheader">
                <T>Machine</T>
              </span>
              <span role="columnheader">T3 Code</span>
              <span role="columnheader">
                <T>Providers</T>
              </span>
              <span role="columnheader" />
            </div>
            {updating.map((row) => (
              <div
                key={row.environmentId ?? "this-app"}
                role="row"
                className="col-span-full grid grid-cols-subgrid border-b border-border/50 py-1.5 last:border-b-0"
              >
                <span role="cell" className="max-w-32 min-w-0">
                  <span className="sr-only">{row.label}</span>
                  <MiddleTruncate value={row.label} aria-hidden />
                </span>
                <span role="cell">
                  {row.app !== null ? m(APP_LABELS[row.app]) : null}
                  {row.app === null && row.skipped !== null ? (
                    <span className="text-muted-foreground">
                      <T>Skipped</T>
                    </span>
                  ) : null}
                  {row.app === "this-app" ? (
                    <span className="block text-muted-foreground text-xs">
                      <T>restarts last</T>
                    </span>
                  ) : null}
                </span>
                <span role="cell">
                  {row.providers.map((provider, index) => (
                    <Fragment key={provider}>
                      <span className="whitespace-nowrap">{provider}</span>
                      {index < row.providers.length - 1 ? ", " : null}
                    </Fragment>
                  ))}
                </span>
                <span role="cell" className="text-right">
                  {row.environmentId !== null && restarting.has(row.environmentId) ? (
                    <RunningThreads
                      environmentId={row.environmentId}
                      continuesThreads={
                        restarts.find((machine) => machine.environmentId === row.environmentId)
                          ?.continuesThreads === true
                      }
                    />
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          {skipped.length > 0 ? (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground data-panel-open:[&_svg]:rotate-90">
                <ChevronRightIcon className="size-3.5 transition-transform" aria-hidden />
                {gt("{count, plural, one {{count} skipped} other {{count} skipped}}", {
                  count: skipped.length,
                })}
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="grid grid-cols-[minmax(0,max-content)_1fr] gap-x-3 gap-y-0.5 pt-1.5 ps-4.5 text-muted-foreground text-xs">
                  {skipped.map((row) => (
                    <Fragment key={row.environmentId ?? "this-app"}>
                      <span className="max-w-32 min-w-0">
                        <MiddleTruncate value={row.label} />
                      </span>
                      <span className="wrap-anywhere">{row.skipped}</span>
                    </Fragment>
                  ))}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </div>
      </ScrollArea>
      <AlertDialogFooter>
        {disabledReason !== null ? (
          <p className="self-center text-sm max-sm:order-1 max-sm:text-center sm:mr-auto">
            {disabledReason}
          </p>
        ) : running > 0 || pacedOrStalled > 0 ? (
          <p className="self-center text-muted-foreground text-sm max-sm:order-1 max-sm:text-center sm:mr-auto">
            {[
              running > 0
                ? stopped === 0
                  ? gt(
                      "{count, plural, one {{count} running thread will be interrupted and can resume after the restart.} other {{count} running threads will be interrupted and can resume after the restart.}}",
                      { count: running },
                    )
                  : continuing === 0
                    ? gt(
                        "{count, plural, one {{count} running thread will be interrupted.} other {{count} running threads will be interrupted.}}",
                        { count: running },
                      )
                    : `${gt(
                        "{count, plural, one {{count} running thread will be interrupted.} other {{count} running threads will be interrupted.}}",
                        { count: running },
                      )} ${gt(
                        "{count, plural, one {{count} can resume after the restart.} other {{count} can resume after the restart.}}",
                        { count: continuing },
                      )}`
                : null,
              pacedOrStalled > 0
                ? gt(
                    "{count, plural, one {{count} paced or stalled thread will go on by itself.} other {{count} paced or stalled threads will go on by themselves.}}",
                    { count: pacedOrStalled },
                  )
                : null,
            ]
              .filter(Boolean)
              .join(" ")}
          </p>
        ) : null}
        <AlertDialogClose ref={cancelRef} render={<Button variant="outline" disabled={busy} />}>
          <T>Cancel</T>
        </AlertDialogClose>
        <Button disabled={disabledReason !== null || busy} onClick={onConfirm}>
          {confirmLabel ?? gt("Update", { $context: "verb, confirms the update" })}
        </Button>
      </AlertDialogFooter>
    </>
  );
}

function RunningThreads({
  environmentId,
  continuesThreads,
}: {
  readonly environmentId: EnvironmentId;
  readonly continuesThreads: boolean;
}) {
  const { running, pacedOrStalled } = useAtomValue(
    restartingThreadCountsAtom(`${continuesThreads ? "continue" : "stop"}\n${environmentId}`),
  );
  const gt = useGT();
  if (running === 0 && pacedOrStalled === 0) return null;
  return (
    <span className="whitespace-nowrap">
      {running > 0 ? (
        <span className="text-warning">
          {gt("{count, plural, one {{count} running} other {{count} running}}", { count: running })}
        </span>
      ) : null}
      {running > 0 && pacedOrStalled > 0 ? (
        <span className="text-muted-foreground"> · </span>
      ) : null}
      {pacedOrStalled > 0 ? (
        <span className="text-muted-foreground">
          {gt("{count, plural, one {{count} paced or stalled} other {{count} paced or stalled}}", {
            count: pacedOrStalled,
          })}
        </span>
      ) : null}
    </span>
  );
}
