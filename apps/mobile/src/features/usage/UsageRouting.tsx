import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  RouterProvider,
  ThreadAccountRouting,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const ROUTER_PROVIDERS = [
  { provider: "claude", driver: "claudeAgent", name: "Claude" },
  { provider: "codex", driver: "codex", name: "Codex" },
] as const satisfies ReadonlyArray<{ provider: RouterProvider; driver: string; name: string }>;

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
  const query = useEnvironmentQuery<ThreadAccountRouting, unknown>(
    serverEnvironment.threadAccountRouting({
      environmentId: props.environmentId,
      input: { sourceId: props.source.id },
    }),
  );
  const runSet = useAtomCommand(serverEnvironment.setThreadAccount, { reportFailure: false });
  const runSteer = useAtomCommand(serverEnvironment.steerThreadAccount, { reportFailure: false });
  const permitted = useAtomValue(
    serverEnvironment.setThreadAccount.permissionAtom(props.environmentId),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const { environmentId, source } = props;
  const disabled = pending || !permitted;
  const nameOf = (alias: string) => {
    const account = source.accounts.find((candidate) => candidate.routerAlias === alias);
    return account?.email ?? alias;
  };
  const until = (iso: string | undefined) =>
    iso
      ? `until ${new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
      : undefined;
  const titleOf = (thread: { readonly title: string } | null, session: string | null) =>
    thread ? thread.title || "Untitled thread" : `${session}…`;
  const providers = ROUTER_PROVIDERS.filter((entry) =>
    source.accounts.some(
      (account) => account.driver === entry.driver && account.routerAlias !== undefined,
    ),
  );

  async function run(perform: () => Promise<AsyncResult.AsyncResult<unknown, unknown>>) {
    setPending(true);
    setError(null);
    const result = await perform();
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not change the routing.");
    }
    query.refresh();
  }

  return (
    <View className="gap-3 rounded-xl border border-border-subtle p-4">
      <Text className="text-base font-t3-medium text-foreground">Routing · {props.label}</Text>
      <Text className="text-xs text-foreground-muted">New threads</Text>
      {providers.map(({ provider, name }) => {
        const steer = routing.steers.find((candidate) => candidate.provider === provider);
        return (
          <Row
            key={provider}
            title={name}
            detail={[
              steer ? nameOf(steer.account) : "Automatic",
              steer?.active === false ? "stored, not active" : undefined,
            ]}
            action={
              steer
                ? {
                    label: "Clear",
                    disabled,
                    onPress: () =>
                      void run(() =>
                        runSteer({
                          environmentId,
                          input: { sourceId: source.id, provider, account: null },
                        }),
                      ),
                  }
                : undefined
            }
          />
        );
      })}
      {routing.pins.length > 0 ? (
        <Text className="text-xs text-foreground-muted">Pinned threads</Text>
      ) : null}
      {routing.pins.map((pin) => {
        const thread = pin.thread;
        const detail = [
          nameOf(pin.account),
          pin.stall ? "waits when it runs out" : "falls back when it runs out",
          until(pin.expiresAt),
          thread ? (pin.active ? undefined : "stored, not active") : "set outside T3",
        ];
        return thread ? (
          <Row
            key={`thread:${thread.id}`}
            title={thread.title || "Untitled thread"}
            detail={detail}
            action={{
              label: "Remove",
              disabled,
              onPress: () =>
                void run(() =>
                  runSet({ environmentId, input: { threadId: thread.id, account: null } }),
                ),
            }}
          />
        ) : (
          <Row
            key={`session:${pin.session}:${pin.account}`}
            title={`${pin.session}…`}
            detail={detail}
          />
        );
      })}
      {routing.held?.length ? (
        <Text className="text-xs text-foreground-muted">Held requests</Text>
      ) : null}
      {routing.held?.map((hold) => (
        <Row
          key={`held:${hold.thread?.id ?? hold.session}:${hold.account}:${hold.kind}`}
          title={titleOf(hold.thread, hold.session)}
          detail={[
            hold.account ? nameOf(hold.account) : "Unknown account",
            hold.kind === "keep_warm" ? "keeping its cache warm" : "waiting for quota",
            until(hold.releaseAt),
          ]}
        />
      ))}
      {routing.margins?.length ? (
        <Text className="text-xs text-foreground-muted">Safety-margin overrides</Text>
      ) : null}
      {routing.margins?.map((margin) => (
        <Row
          key={`margin:${margin.thread?.id ?? margin.session}`}
          title={titleOf(margin.thread, margin.session)}
          detail={[
            `${Math.round(margin.headroomScale * 100)}% of the usual headroom`,
            margin.actor ? `set by ${margin.actor}` : undefined,
            until(margin.expiresAt),
          ]}
        />
      ))}
      {error ? (
        <Text accessibilityRole="alert" className="text-xs text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function Row(props: {
  readonly title: string;
  readonly detail: ReadonlyArray<string | undefined>;
  readonly action?:
    | { readonly label: string; readonly disabled: boolean; readonly onPress: () => void }
    | undefined;
}) {
  return (
    <View className="min-h-11 flex-row items-center gap-3">
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          {props.detail.filter(Boolean).join(" · ")}
        </Text>
      </View>
      {props.action ? (
        <Pressable
          accessibilityRole="button"
          disabled={props.action.disabled}
          onPress={props.action.onPress}
          className="min-h-11 justify-center px-2 active:opacity-60"
        >
          <Text className="text-sm font-t3-medium text-primary">{props.action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
