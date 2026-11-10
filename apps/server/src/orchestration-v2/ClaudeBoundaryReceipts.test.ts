import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import { makeClaudeBoundaryReceiptRecovery } from "./ClaudeBoundaryReceipts.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

it.effect("settles every offer left open at startup as delivered in its original run", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("recovery-thread");
    const projection = {
      thread: { id: threadId, archivedAt: null, deletedAt: null },
      runs: [
        ...["first", "second"].map((id) => ({
          id: `queued-${id}`,
          userMessageId: `message-${id}`,
          status: "queued",
          queueHeld: true,
          boundaryOffer: { id, targetRunId: "original-run", providerTurnId: "original-turn" },
        })),
        { id: "queued-plain", userMessageId: "message-plain", status: "queued" },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const operations: unknown[] = [];
    const recover = yield* makeClaudeBoundaryReceiptRecovery.pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            dispatch: (command) =>
              Effect.sync(() => {
                operations.push(command);
                return {} as never;
              }),
          }),
          Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
            reserveBoundary: (reservation) =>
              Effect.sync(() => {
                operations.push(reservation);
              }),
          }),
        ),
      ),
    );
    yield* recover;
    assert.deepEqual(
      operations,
      ["first", "second"].flatMap((id) => [
        {
          threadId,
          turnItemId: `turn-item:message:message-${id}`,
          runId: "original-run",
          queuedRunId: `queued-${id}`,
          offerId: id,
          providerTurnId: "original-turn",
        },
        {
          type: "queued-message.promote-to-steer",
          commandId: `tool-boundary-receipt:${id}`,
          threadId,
          queuedRunId: `queued-${id}`,
          targetRunId: "original-run",
          boundaryOffer: { id, step: "receipt" },
        },
      ]),
    );
  }),
);
