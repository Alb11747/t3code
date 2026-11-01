import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadMetadataMcpUpdateInput } from "./threadMetadataMcp.ts";

const decodeUpdate = Schema.decodeUnknownSync(ThreadMetadataMcpUpdateInput);

describe("ThreadMetadataMcpUpdateInput", () => {
  it("requires note text only for setting a context note, defaults prepend and accepts clearing", () => {
    assert.deepEqual(decodeUpdate({ action: "set_context_note", contextNote: null }), {
      action: "set_context_note",
      contextNote: null,
    });
    assert.deepEqual(
      decodeUpdate({
        action: "set_context_note",
        contextNote: { text: "Current coordinator", mode: "replace" },
      }).contextNote,
      { text: "Current coordinator", mode: "replace" },
    );
    const markdown = "    indented code\n\n";
    assert.equal(
      decodeUpdate({ action: "set_context_note", contextNote: { text: markdown } }).contextNote
        ?.text,
      markdown,
    );
    for (const input of [
      { action: "set_context_note" },
      { action: "set_context_note", contextNote: { text: " ", mode: "prepend" } },
      { action: "set_context_note", contextNote: { text: "x".repeat(4001), mode: "prepend" } },
      { action: "rename", title: "New", contextNote: null },
    ])
      assert.throws(() => decodeUpdate(input));
    assert.equal(
      decodeUpdate({ action: "set_context_note", contextNote: { text: "Note" } }).contextNote?.mode,
      "prepend",
    );
  });

  it("rejects malformed client request ids without normalizing valid keys", () => {
    const validKey = "metadata-\ud83d\ude80-1";
    assert.equal(
      decodeUpdate({ action: "regenerate_title", clientRequestId: validKey }).clientRequestId,
      validKey,
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\ud800" }),
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\udc00" }),
    );
  });
});
