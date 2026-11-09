import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

const project = vi.hoisted(() => ({ readFile: vi.fn(), optimisticFile: vi.fn() }));

vi.mock(import("~/state/projects"), () => ({ projectEnvironment: project }) as never);
vi.mock(
  import("~/state/filesystem"),
  () =>
    ({
      useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
    }) as never,
);
vi.mock(import("~/state/queries"), () => ({ useProjectPathSearch: vi.fn() }) as never);

import { useProjectFileQuery } from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("file-preview-open");

function Preview({ openRequestId }: { openRequestId: number }) {
  const file = useProjectFileQuery(environmentId, "/repo", "notes.diff", true, openRequestId);
  return <output>{file.data?.contents}</output>;
}

describe("file preview reads", () => {
  it("reads host edits on reopen and on another open of the selected file", async () => {
    let contents = "Revision A";
    let reads = 0;
    const query = Atom.make(
      Effect.promise(async () => {
        reads++;
        return {
          contents,
          relativePath: "notes.diff",
          byteLength: contents.length,
          truncated: false,
        };
      }),
    ).pipe(Atom.setIdleTTL(300_000));
    project.readFile.mockReset().mockReturnValue(query);
    project.optimisticFile.mockReset().mockReturnValue(Atom.make(null));

    const view = (openRequestId: number | null) => (
      <AppAtomRegistryProvider>
        {openRequestId === null ? null : <Preview openRequestId={openRequestId} />}
      </AppAtomRegistryProvider>
    );

    await using screen = await render(view(1));
    await expect.element(screen.getByRole("status")).toHaveTextContent("Revision A");
    expect(reads).toBe(1);

    await screen.rerender(view(null));
    contents = "Revision B";
    await screen.rerender(view(1));
    await expect.element(screen.getByRole("status")).toHaveTextContent("Revision B");
    expect(reads).toBe(2);

    contents = "Revision C";
    await screen.rerender(view(2));
    await expect.element(screen.getByRole("status")).toHaveTextContent("Revision C");
    expect(reads).toBe(3);
  });
});
