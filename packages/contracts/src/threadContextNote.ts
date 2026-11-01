import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

export const ThreadContextNoteInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(4_000)).check(
    Schema.makeFilter((value) => value.trim().length > 0 || "The thread note must not be blank."),
  ),
  mode: Schema.Literals(["prepend", "replace"])
    .pipe(Schema.withDecodingDefault(Effect.succeed("prepend" as const)))
    .annotate({
      description:
        "prepend (default) shows the note before opening messages; replace substitutes their preview.",
    }),
});
export type ThreadContextNoteInput = typeof ThreadContextNoteInput.Type;

export const ThreadContextNoteAuthor = Schema.Struct({
  kind: Schema.Literals(["user", "agent"]),
  threadId: Schema.optional(ThreadId),
});

export const ThreadContextNoteUpdate = Schema.Struct({
  ...ThreadContextNoteInput.fields,
  author: ThreadContextNoteAuthor,
});
export type ThreadContextNoteUpdate = typeof ThreadContextNoteUpdate.Type;

export const ThreadContextNote = Schema.Struct({
  ...ThreadContextNoteUpdate.fields,
  mode: Schema.Literals(["prepend", "replace"]),
  updatedAt: IsoDateTime,
});
export type ThreadContextNote = typeof ThreadContextNote.Type;
