import { useState } from "react";

import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import { Label } from "../ui/label";

const MAX_SUGGESTIONS = 50;

// Intl omits UTC from its list on some engines, and agents often save it.
const TIME_ZONES: ReadonlyArray<string> = [
  ...new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]),
];

/** Fork: edits a fixed-time task's IANA time zone; empty means the server's local zone. */
export function ScheduledTaskTimeZoneField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const query = value.trim().toLowerCase().replaceAll(" ", "_");
  const matches = (
    query ? TIME_ZONES.filter((zone) => zone.toLowerCase().includes(query)) : TIME_ZONES
  ).slice(0, MAX_SUGGESTIONS);
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="scheduled-task-time-zone">Time zone</Label>
      <Autocomplete
        items={matches}
        mode="none"
        openOnInputClick
        open={open && matches.length > 0}
        onOpenChange={setOpen}
        value={value}
        onValueChange={(next) => onChange(next)}
      >
        <div className="w-56">
          <AutocompleteInput
            id="scheduled-task-time-zone"
            placeholder="Server local"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <AutocompletePopup>
          <AutocompleteList className="max-h-64">
            {matches.map((zone) => (
              <AutocompleteItem key={zone} value={zone}>
                {zone}
              </AutocompleteItem>
            ))}
          </AutocompleteList>
          <AutocompleteEmpty>No matching time zone.</AutocompleteEmpty>
        </AutocompletePopup>
      </Autocomplete>
    </div>
  );
}
