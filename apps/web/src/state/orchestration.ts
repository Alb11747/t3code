import { createOrchestrationEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentShell } from "./shell";

// Deleting an already-omitted thread leaves the title query's IDs unchanged.
const threadTitleRefreshes = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      AsyncResult.getOrElse(get(environmentShell.stateAtom(environmentId)), () => null)?.removedAt,
  ),
);

export const orchestrationEnvironment = createOrchestrationEnvironmentAtoms(connectionAtomRuntime, {
  threadTitlesRefreshTrigger: threadTitleRefreshes,
});
