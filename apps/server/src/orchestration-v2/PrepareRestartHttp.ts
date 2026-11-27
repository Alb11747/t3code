import { AuthEnvironmentMaintainScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as IdleCompactionService from "./IdleCompactionService.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "maintenance",
  Effect.fnUntraced(function* (handlers) {
    const idleCompaction = yield* IdleCompactionService.IdleCompactionService;
    return handlers.handle(
      "prepareRestart",
      Effect.fn("environment.maintenance.prepareRestart")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthEnvironmentMaintainScope);
        return yield* idleCompaction.prepareRestart(args.payload).pipe(
          traceLocalHandlerWork,
          Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
        );
      }),
    );
  }),
);
