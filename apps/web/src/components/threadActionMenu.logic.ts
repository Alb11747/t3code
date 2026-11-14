import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

import { USAGE_RESET_SNOOZE_ACTION, USAGE_RESET_SNOOZE_LABEL } from "./usageResetSnooze.logic";

export type ThreadActionMenuId =
  | "find"
  | "new-thread-on-branch"
  | "filter-by-project"
  | "turn-into-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:always"
  | "auto-settle:disabled"
  | "compact-before-expiry"
  | "compact-before-expiry:default"
  | "compact-before-expiry:once"
  | "compact-before-expiry:on"
  | "compact-before-expiry:off"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "context-note"
  | "regenerate-title"
  | "mark-unread"
  | "share-guest"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "archive"
  | "delete";

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: "Project settings", icon: "settings" }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly canFind?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  /** Undefined when the server has no per-thread When done. */
  readonly autoSettleAlways?: boolean | undefined;
  /** Undefined when the server has no per-thread idle compaction. */
  readonly compactBeforeCacheExpires?: boolean | null | undefined;
  /** Undefined when the server has no one-shot compaction mark. */
  readonly compactOnce?: boolean | undefined;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** Guest links need their own grant, so the caller checks it instead of `canOperate`. */
  readonly canShareWithGuest?: boolean;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
}

/** Local navigation, read markers, and copying remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  return ![
    "find",
    "new-thread-on-branch",
    "project-settings",
    "mark-unread",
    "share-guest",
    "copy",
    "copy-path",
    "copy-branch",
    "copy-thread",
    "copy-thread-id",
  ].includes(action);
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.canFind
      ? [{ id: "find" as const, label: "Find in thread", icon: "text-search" }]
      : []),
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin thread", icon: "pin" },
        ]
      : []),
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: preset.label,
                    detail: preset.whenLabel,
                  })),
                  {
                    id: USAGE_RESET_SNOOZE_ACTION,
                    label: USAGE_RESET_SNOOZE_LABEL,
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                  { id: "snooze:custom" as const, label: "Custom…" },
                ],
              },
        ]
      : []),
    { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
    { id: "context-note", label: "Context note…", icon: "pencil" },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    ...(state.canShareWithGuest
      ? [{ id: "share-guest" as const, label: "Share with guest", icon: "user-plus" }]
      : []),
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? "Show all projects"
              : `Filter by ${state.projectFilter.label}`,
            icon: "folder-tree",
          },
        ]
      : []),
    ...(state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: "Turn into project",
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Auto-settle behavior",
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "Follow settings",
                checked: state.autoSettleEnabled && state.autoSettleAlways !== true,
              },
              ...(state.autoSettleAlways === undefined
                ? []
                : [
                    {
                      id: "auto-settle:always" as const,
                      label: "When done",
                      checked: state.autoSettleAlways,
                    },
                  ]),
              {
                id: "auto-settle:disabled" as const,
                label: "Never",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    ...(state.compactBeforeCacheExpires !== undefined
      ? [
          {
            id: "compact-before-expiry" as const,
            label: "Compact before cache expires",
            icon: "timer",
            children: [
              {
                id: "compact-before-expiry:default" as const,
                label: "Follow settings",
                checked: state.compactBeforeCacheExpires === null && state.compactOnce !== true,
              },
              // The server refuses a one-shot mark on a thread set to Never.
              ...(state.compactOnce === undefined || state.compactBeforeCacheExpires === false
                ? []
                : [
                    {
                      id: "compact-before-expiry:once" as const,
                      label: "This time only",
                      checked: state.compactOnce,
                    },
                  ]),
              {
                id: "compact-before-expiry:on" as const,
                label: "Always",
                checked: state.compactBeforeCacheExpires === true && state.compactOnce !== true,
              },
              {
                id: "compact-before-expiry:off" as const,
                label: "Never",
                checked: state.compactBeforeCacheExpires === false,
              },
            ],
          },
        ]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
        { id: "copy-thread", label: "Thread", icon: "message-square" },
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: "Delete",
      destructive: true,
      icon: "trash",
    },
  ];
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}

export function compactBeforeCacheExpiresChoice(
  action:
    | "compact-before-expiry:default"
    | "compact-before-expiry:once"
    | "compact-before-expiry:on"
    | "compact-before-expiry:off",
): boolean | null | "once" {
  if (action === "compact-before-expiry:default") return null;
  if (action === "compact-before-expiry:once") return "once";
  return action === "compact-before-expiry:on";
}
