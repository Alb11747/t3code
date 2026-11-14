import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  RouterProvider,
  ThreadAccountRouting,
  ThreadId,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { accountLabel } from "../chat/threadAccountChoice";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const ROUTER_PROVIDERS: ReadonlyArray<{
  readonly provider: RouterProvider;
  readonly driver: string;
  readonly name: string;
}> = [
  { provider: "claude", driver: "claudeAgent", name: "Claude" },
  { provider: "codex", driver: "codex", name: "Codex" },
];

/** Fork: whether a hub snapshot lists quota-router accounts, so its routing is worth reading. */
export function routesThreads(source: UsageLimitSourceSnapshot): boolean {
  return source.accounts.some(
    (account) =>
      account.routerAlias !== undefined &&
      ROUTER_PROVIDERS.some((entry) => entry.driver === account.driver),
  );
}

/**
 * Fork: a CLI Proxy hub's steers and pins, as its quota router lists them. Renders nothing while
 * loading, on a read failure (stock hubs have no control endpoint) or with nothing to show.
 */
export function UsageRouting(props: {
  readonly environmentId: EnvironmentId;
  readonly source: UsageLimitSourceSnapshot;
  readonly label: string;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.threadAccountRouting({
      environmentId: props.environmentId,
      input: { sourceId: props.source.id },
    }),
  );
  const routing = query.data;
  if (
    !routing ||
    (routing.steers.length === 0 &&
      routing.pins.length === 0 &&
      !routing.held?.length &&
      !routing.margins?.length)
  ) {
    return null;
  }
  return <RoutingSection {...props} routing={routing} refresh={query.refresh} />;
}

function RoutingSection(props: {
  readonly environmentId: EnvironmentId;
  readonly source: UsageLimitSourceSnapshot;
  readonly label: string;
  readonly routing: NonNullable<ThreadAccountRouting>;
  readonly refresh: () => void;
}) {
  const { environmentId, source, routing } = props;
  const [busy, setBusy] = useState(false);
  const runSet = useAtomCommand(serverEnvironment.setThreadAccount, { reportFailure: false });
  const runSteer = useAtomCommand(serverEnvironment.steerThreadAccount, { reportFailure: false });
  const permitted = useAtomValue(serverEnvironment.setThreadAccount.permissionAtom(environmentId));
  const nameOf = (alias: string) => {
    const account = source.accounts.find((candidate) => candidate.routerAlias === alias);
    return account ? accountLabel(account) : alias;
  };
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const until = (iso: string | undefined) =>
    iso ? ` · until ${formatUpcomingTimestamp(iso, timestampFormat)}` : "";
  const sessionTitle = (
    thread: { readonly id: ThreadId; readonly title: string } | null,
    session: string | null,
  ) =>
    thread ? (
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId: thread.id }}
        className="truncate hover:underline"
      >
        {thread.title || "Untitled thread"}
      </Link>
    ) : (
      <span className="font-mono">{session}…</span>
    );
  const providers = ROUTER_PROVIDERS.filter((entry) =>
    source.accounts.some(
      (account) => account.driver === entry.driver && account.routerAlias !== undefined,
    ),
  );

  async function run(title: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title,
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    props.refresh();
  }

  const clearSteer = (provider: RouterProvider) =>
    run("Could not clear the account for new threads", () =>
      runSteer({ environmentId, input: { sourceId: source.id, provider, account: null } }),
    );
  const removePin = (threadId: ThreadId) =>
    run("Could not set the thread back to Automatic", () =>
      runSet({ environmentId, input: { threadId, account: null } }),
    );

  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4">
      <h2 className="text-sm font-medium">Routing · {props.label}</h2>
      <div className="flex flex-col gap-1">
        <h3 className="text-xs text-muted-foreground">New threads</h3>
        {providers.map(({ provider, name }) => {
          const steer = routing.steers.find((candidate) => candidate.provider === provider);
          return (
            <RoutingRow
              key={provider}
              title={name}
              detail={steer ? nameOf(steer.account) : "Automatic"}
              inactive={
                steer?.active === false
                  ? "Saved in T3; it is renewed on the hub shortly."
                  : undefined
              }
              action={
                steer ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy || !permitted}
                    onClick={() => void clearSteer(provider)}
                  >
                    Clear
                  </Button>
                ) : null
              }
            />
          );
        })}
      </div>
      {routing.pins.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs text-muted-foreground">Pinned threads</h3>
          {routing.pins.map((pin) => {
            const detail = `${nameOf(pin.account)} · ${pin.stall ? "waits when it runs out" : "falls back when it runs out"}${until(pin.expiresAt)}`;
            return pin.thread ? (
              <RoutingRow
                key={`thread:${pin.thread.id}`}
                title={sessionTitle(pin.thread, null)}
                detail={detail}
                inactive={
                  pin.active
                    ? undefined
                    : "The hub does not list this pin; the next turn pins it again."
                }
                action={
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy || !permitted}
                    onClick={() => void removePin(pin.thread!.id)}
                  >
                    Remove
                  </Button>
                }
              />
            ) : (
              <RoutingRow
                key={`session:${pin.session}:${pin.account}`}
                title={sessionTitle(null, pin.session)}
                detail={detail}
                note="set outside T3"
              />
            );
          })}
        </div>
      ) : null}
      {routing.held?.length ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs text-muted-foreground">Held requests</h3>
          {routing.held.map((hold) => (
            <RoutingRow
              key={`held:${hold.thread?.id ?? hold.session}:${hold.account}:${hold.kind}`}
              title={sessionTitle(hold.thread, hold.session)}
              detail={`${hold.account ? nameOf(hold.account) : "Unknown account"} · ${hold.kind === "keep_warm" ? "keeping its cache warm" : "waiting for quota"}${until(hold.releaseAt)}`}
            />
          ))}
        </div>
      ) : null}
      {routing.margins?.length ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs text-muted-foreground">Safety-margin overrides</h3>
          {routing.margins.map((margin) => (
            <RoutingRow
              key={`margin:${margin.thread?.id ?? margin.session}`}
              title={sessionTitle(margin.thread, margin.session)}
              detail={`${Math.round(margin.headroomScale * 100)}% of the usual headroom${margin.actor ? ` · set by ${margin.actor}` : ""}${until(margin.expiresAt)}`}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RoutingRow(props: {
  readonly title: ReactNode;
  readonly detail: string;
  /** Why a choice T3 stores is not active on the hub. */
  readonly inactive?: string | undefined;
  readonly note?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-center gap-2 text-sm">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate">{props.title}</span>
        {props.inactive ? (
          <Badge size="sm" variant="warning" title={props.inactive}>
            stored, not active
          </Badge>
        ) : null}
        {props.note ? (
          <Badge size="sm" variant="secondary">
            {props.note}
          </Badge>
        ) : null}
      </span>
      <span className="min-w-0 truncate text-xs text-muted-foreground">{props.detail}</span>
      {props.action}
    </div>
  );
}
