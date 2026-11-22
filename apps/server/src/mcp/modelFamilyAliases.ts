// Fork: resolve model family inputs and preserve a scheduled create's accepted selection.
import {
  type CommandId,
  type ModelSelection,
  OrchestratorMcpFailure,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";
import { isModelFamilyAlias } from "@t3tools/shared/latestModel";
import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import type { OrchestratorMcpService } from "./OrchestratorMcpService.ts";

export const makeResolveAdvertisedModelSelection = (
  withWorkspaceModels: (
    providers: ReadonlyArray<ServerProvider>,
    cwd: string | undefined,
  ) => ReadonlyArray<ServerProvider>,
  requireAdvertisedModel: (
    provider: ServerProvider,
    model: string,
  ) => Effect.Effect<string, OrchestratorMcpFailure>,
) =>
  Effect.fn("mcp.resolveAdvertisedModelSelection")(function* (
    selection: ModelSelection,
    cwd?: string,
  ) {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const { instanceId, model } = selection;
    const resolve = (
      providers: ReadonlyArray<ServerProvider>,
    ): Effect.Effect<string, OrchestratorMcpFailure> => {
      const provider = withWorkspaceModels(providers, cwd).find(
        (candidate) => candidate.instanceId === instanceId,
      );
      if (provider !== undefined) return requireAdvertisedModel(provider, model);
      return isModelFamilyAlias(model)
        ? Effect.fail(
            new OrchestratorMcpFailure({
              code: "provider_unavailable",
              message: `Provider instance ${instanceId} is not registered.`,
            }),
          )
        : Effect.succeed(model);
    };
    const initial = resolve(yield* registry.getProviders);
    const resolved = yield* cwd === undefined
      ? initial
      : initial.pipe(
          Effect.catchIf(
            (error) => error.code === "model_unavailable",
            () =>
              ProjectService.ProjectService.pipe(
                Effect.flatMap((projects) => projects.workspaceScanDirectory(cwd)),
                Effect.flatMap((scanCwd) =>
                  registry.refreshWorkspaceSnapshot({ instanceId, cwd, scanCwd }),
                ),
                Effect.flatMap(resolve),
              ),
          ),
        );
    return resolved === model ? selection : { ...selection, model: resolved };
  });

export const usesScheduledFamilyAlias = (selection: ModelSelection | null | undefined) =>
  selection != null && isModelFamilyAlias(selection.model);

export function scheduledTaskFollowLatestModel(
  explicit: boolean | undefined,
  familyAlias: boolean,
) {
  const followLatestModel = explicit ?? (familyAlias ? true : undefined);
  return followLatestModel === undefined ? {} : { followLatestModel };
}

export const boundScheduledFamilyAliasFailure = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message:
      "A bound task uses its thread's model. Pass bindToCurrentThread: false to schedule a task on a model family.",
  });

export const findAcceptedSchedule = Effect.fn("mcp.findAcceptedSchedule")(function* (
  scheduledTasks: ScheduledTaskService.ScheduledTaskService["Service"],
  commandId: CommandId | undefined,
  projectId: ProjectId,
) {
  if (commandId === undefined) return null;
  const accepted = yield* scheduledTasks
    .findByCreateCommand(commandId)
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
    );
  if (accepted !== null && accepted.projectId !== projectId) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "A schedule retry must use the original project.",
    });
  }
  return accepted;
});

type ScheduleTask = OrchestratorMcpService["Service"]["scheduleTask"];

export const keepsAcceptedSchedule = (input: Parameters<ScheduleTask>[1]) =>
  input.clientRequestId !== undefined &&
  (usesScheduledFamilyAlias(input.modelSelection) || input.script !== undefined);

export const serializeScheduleTask = (
  scheduleTask: ScheduleTask,
  semaphore: Semaphore.Semaphore,
): ScheduleTask =>
  // The wrapped operation supplies the trace and the permit protects lookup through save.
  Effect.fnUntraced(function* (...args: Parameters<ScheduleTask>) {
    const [, input] = args;
    const effect = scheduleTask(...args);
    return yield* keepsAcceptedSchedule(input) ? semaphore.withPermit(effect) : effect;
  });

export const acceptedFamilySelection = (
  requested: string | undefined,
  committed: ModelSelection | undefined,
) => (requested !== undefined && isModelFamilyAlias(requested) ? committed : undefined);
