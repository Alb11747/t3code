import { AuthFilesystemReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { assetEnvironment } from "../state/assets";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { reportMarkdownActionFailure } from "./chat/markdownActionFailure";
import { stackedThreadToast, toastManager } from "./ui/toast";

export function useDownloadMarkdownFile(threadRef: ScopedThreadRef | undefined) {
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const downloadMarkdownFile = async (filePath: string) => {
    if (!threadRef) return;
    // A catch callback rather than try/catch: React Compiler skips components
    // that throw inside try.
    const download = async () => {
      const { environmentId, threadId } = threadRef;
      if (!readEnvironmentScope(environmentId, AuthFilesystemReadScope)) {
        throw new Error("This connection cannot read host files.");
      }
      const connection = readPreparedConnection(environmentId);
      if (!connection) throw new Error("Reconnect to this environment and try again.");
      const result = await createAssetUrl({
        environmentId,
        input: {
          resource: { _tag: "media-file", threadId, path: filePath, disposition: "attachment" },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (!readEnvironmentScope(environmentId, AuthFilesystemReadScope)) {
        throw new Error("This connection cannot read host files.");
      }
      const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
      if (!url) throw new Error("The environment returned an invalid file URL.");
      if (window.desktopBridge?.downloadFile) {
        if (!(await window.desktopBridge.downloadFile(url))) {
          throw new Error("The desktop app could not start the download.");
        }
        return;
      }
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    };
    await download().catch((cause: unknown) => {
      reportMarkdownActionFailure({ operation: "download-file", target: filePath }, cause);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not download file",
          description: cause instanceof Error ? cause.message : "The download failed.",
        }),
      );
    });
  };
  return downloadMarkdownFile;
}
