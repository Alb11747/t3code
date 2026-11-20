import { useGT } from "gt-react-native";
import { SettingsRow } from "../settings/components/SettingsRow";
import { checkForkUpdate, installForkUpdate, useForkUpdateState } from "./fork-updates";

export function ForkUpdateSettings() {
  const gt = useGT();
  const state = useForkUpdateState();
  return (
    <>
      <SettingsRow
        icon="arrow.clockwise"
        label={gt("Fork updates")}
        value={state.status}
        disabled={state.busy}
        onPress={() => {
          void checkForkUpdate();
        }}
      />
      {state.lastCheck ? (
        <SettingsRow icon="clock" label={gt("Last checked")} value={state.lastCheck} />
      ) : null}
      <SettingsRow
        icon="arrow.down.circle"
        label={gt("Check now")}
        disabled={state.busy}
        onPress={() => {
          void checkForkUpdate();
        }}
      />
      {state.ready ? (
        <SettingsRow
          icon="arrow.down.circle"
          label={gt("Install now")}
          disabled={state.busy}
          onPress={() => {
            void installForkUpdate();
          }}
        />
      ) : null}
    </>
  );
}
