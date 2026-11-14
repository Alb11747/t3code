// Fork: scheduled tasks that follow the newest model of their family.
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { modelFamilyName, resolveLatestFamilyModel } from "@t3tools/shared/latestModel";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The flag rides in model_selection_json, which ModelSelection decoding ignores, so no column is needed.
// Risk: an upstream migration that rebuilds this column from ModelSelection's fields (as 016 did
// elsewhere with json_object) would silently turn every task's flag off. Check such migrations.
const decodeFlag = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ followLatestModel: Schema.optional(Schema.Boolean) })),
);

/** Saves drop the flag for a model outside the followed families, so it never reads as on. */
export const canFollow = (selection: ModelSelection) => modelFamilyName(selection.model) !== null;

export function readFollowLatestModel(modelSelectionJson: string): boolean {
  return Option.match(decodeFlag(modelSelectionJson), {
    onNone: () => false,
    onSome: (value) => value.followLatestModel === true,
  });
}

export function modelSelectionJson(task: {
  readonly modelSelection: ModelSelection;
  readonly followLatestModel?: boolean | undefined;
}): string {
  return JSON.stringify(
    task.followLatestModel
      ? { ...task.modelSelection, followLatestModel: true }
      : task.modelSelection,
  );
}

/**
 * The selection moved to its instance's newest family model (see resolveLatestFamilyModel), or the
 * same object when it stays. Choices the new model does not offer fall back to its default.
 */
export function latestModelSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const models =
    providers.find((provider) => provider.instanceId === selection.instanceId)?.models ?? [];
  const model = resolveLatestFamilyModel(selection.model, models);
  if (model === selection.model) return selection;
  return withOfferedOptions(selection.instanceId, model, selection.options, models);
}

/** The selection with only the choices `model` offers, so the others fall back to its default. */
export function withOfferedOptions(
  instanceId: ModelSelection["instanceId"],
  model: string,
  selections: ModelSelection["options"],
  models: ServerProvider["models"],
): ModelSelection {
  const descriptors = models.find((entry) => entry.slug === model)?.capabilities?.optionDescriptors;
  const options = selections?.filter((option) => {
    const descriptor = descriptors?.find((entry) => entry.id === option.id);
    return descriptor?.type !== "select" || descriptor.options.some((o) => o.id === option.value);
  });
  return {
    instanceId,
    model,
    ...(options === undefined || options.length === 0 ? {} : { options }),
  };
}

/**
 * Why `selections` do not fit `model`'s described options, naming what it offers, or null. A model
 * that describes no options cannot be checked, as for MCP targets.
 */
export function invalidOptionChoices(
  model: string,
  selections: NonNullable<ModelSelection["options"]>,
  models: ServerProvider["models"],
): string | null {
  const descriptors = models.find((entry) => entry.slug === model)?.capabilities?.optionDescriptors;
  if (descriptors === undefined) return null;
  const seen = new Set<string>();
  const refused = selections.filter((selection) => {
    const repeated = seen.has(selection.id);
    seen.add(selection.id);
    const descriptor = descriptors.find((entry) => entry.id === selection.id);
    return (
      repeated ||
      descriptor === undefined ||
      (descriptor.type === "boolean"
        ? typeof selection.value !== "boolean"
        : !descriptor.options.some((option) => option.id === selection.value))
    );
  });
  if (refused.length === 0) return null;
  const offered = descriptors
    .map(
      (descriptor) =>
        `${descriptor.id} (${descriptor.type === "select" ? descriptor.options.map((option) => option.id).join(", ") : "true or false"})`,
    )
    .join("; ");
  return `${model} does not offer ${refused.map((selection) => `${selection.id}: ${String(selection.value)}`).join(", ")}. It offers ${offered || "no options"}.`;
}
