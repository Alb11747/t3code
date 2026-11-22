import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "./hooks/useLocalStorage";

export const LAST_SELECTED_MACHINE_STORAGE_KEY = "t3code:last-selected-machine:v1";
const LastSelectedMachine = Schema.NullOr(EnvironmentId);

export function rememberSelectedMachine(environmentId: EnvironmentId) {
  writeLocalStorageValue(
    LAST_SELECTED_MACHINE_STORAGE_KEY,
    environmentId,
    null,
    LastSelectedMachine,
  );
}

export function readLastSelectedMachine() {
  return readLocalStorageValue(LAST_SELECTED_MACHINE_STORAGE_KEY, null, LastSelectedMachine);
}

export function useLastSelectedMachine() {
  const [environmentId] = useLocalStorage(
    LAST_SELECTED_MACHINE_STORAGE_KEY,
    null,
    LastSelectedMachine,
  );
  return environmentId;
}
