import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

// An offer still open at startup lost the process that held it, and whether the agent read it
// is unknowable. It counts as delivered so it is never sent twice, which loses an update the
// server stopped before writing, or one Claude never read before it exited.
export const makeClaudeBoundaryReceiptRecovery = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  return Effect.gen(function* () {
    for (const threadId of yield* projections.getRecoveryThreadIds("boundary-offers")) {
      yield* Effect.gen(function* () {
        const queued = yield* threads.getThreadRecords(threadId, ["runs"], {
          runStatuses: ["queued"],
        });
        if (queued.thread.archivedAt !== null || queued.thread.deletedAt !== null) return;
        for (const run of queued.runs) {
          const offer = run.boundaryOffer;
          if (run.status !== "queued" || offer === undefined) continue;
          yield* positions.reserveBoundary({
            threadId,
            turnItemId: ids.derive.userTurnItem({ messageId: run.userMessageId }),
            runId: offer.targetRunId,
            queuedRunId: run.id,
            offerId: offer.id,
            providerTurnId: offer.providerTurnId,
          });
          yield* threads.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make(`tool-boundary-receipt:${offer.id}`),
            threadId,
            queuedRunId: run.id,
            targetRunId: offer.targetRunId,
            boundaryOffer: { id: offer.id, step: "receipt" },
          });
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Claude boundary offer recovery failed", { threadId, cause }),
        ),
      );
    }
  }).pipe(Effect.withSpan("recoverClaudeBoundaryReceipts"));
});
