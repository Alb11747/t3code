// @effect-diagnostics nodeBuiltinImport:off -- The named pipe is private to the Windows job helper.
import * as NodeNet from "node:net";

export interface WindowsClaudeJob {
  readonly pipe: string;
  readonly gate: string;
  readonly released: Promise<void>;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly processExited: () => void;
}

export async function createWindowsClaudeJob(id: string): Promise<WindowsClaudeJob> {
  const pipe = "\\\\.\\pipe\\t3-claude-job-" + id;
  const gate = "Local\\t3-claude-job-" + id;
  const released = Promise.withResolvers<void>();
  const sockets = new Set<NodeNet.Socket>();
  let control: NodeNet.Socket | undefined;
  let receipts: NodeNet.Socket | undefined;
  let processStarted = false;
  let authorized = false;
  let stopping = false;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    if (server.listening) server.close();
    for (const socket of sockets) socket.destroy();
    released.resolve();
  };
  const authorize = () => {
    if (
      !processStarted ||
      control === undefined ||
      receipts === undefined ||
      finished ||
      authorized
    )
      return;
    authorized = true;
    server.close();
    control.write("S");
  };
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.once("data", (data: Buffer) => {
      const role = data.subarray(0, 1).toString();
      const receive = (chunk: Buffer) => {
        if (chunk.length === 1 && chunk[0] === 68) finish();
      };
      if (role === "C" && control === undefined) {
        control = socket;
      } else if (role === "A" && receipts === undefined) {
        receipts = socket;
        socket.on("data", receive);
        receive(data.subarray(1));
      } else {
        socket.destroy();
      }
      authorize();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(pipe, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return {
    pipe,
    gate,
    released: released.promise,
    start: () => {
      processStarted = true;
      authorize();
    },
    stop: () => {
      if (!authorized) finish();
      else if (!stopping && !finished) {
        stopping = true;
        control?.write("T");
      }
      return released.promise;
    },
    processExited: () => {
      // A worker exit event can be synthetic. No launched job is released without its receipt.
      if (!authorized) finish();
    },
  };
}
