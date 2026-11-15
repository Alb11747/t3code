import { SettingsRow } from "../settings/components/SettingsRow";
import { checkForkUpdate, installForkUpdate, useForkUpdateState } from "./fork-updates";

export function ForkUpdateSettings() {
  const state = useForkUpdateState();
  return (
    <>
      <SettingsRow
        icon="arrow.clockwise"
        label="Fork updates"
        value={state.status}
        disabled={state.busy}
        onPress={() => {
          void checkForkUpdate();
        }}
      />
      {state.lastCheck ? (
        <SettingsRow icon="clock" label="Last checked" value={state.lastCheck} />
      ) : null}
      <SettingsRow
        icon="arrow.down.circle"
        label="Check now"
        disabled={state.busy}
        onPress={() => {
          void checkForkUpdate();
        }}
      />
      {state.ready ? (
        <SettingsRow
          icon="arrow.down.circle"
          label="Install now"
          disabled={state.busy}
          onPress={() => {
            void installForkUpdate();
          }}
        />
      ) : null}
    </>
  );
}
