export * as SessionLoop from "./session-loop"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, PositiveInt } from "./schema"
import { SessionID } from "./session-id"

export const Status = Schema.Literals(["active", "stopped", "exhausted"]).annotate({
  identifier: "SessionLoop.Status",
})
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  prompt: Schema.String.annotate({
    description: "The prompt admitted to the session on every iteration",
  }),
  interval: optional(
    PositiveInt.annotate({
      description:
        "Milliseconds between iterations. Absent means the loop is self-paced and the model chooses each delay",
    }),
  ),
  iterations: NonNegativeInt.annotate({ description: "Number of iterations already admitted" }),
  budget: PositiveInt.annotate({
    description: "Maximum number of iterations before the loop is exhausted",
  }),
  status: Status,
  nextRun: optional(
    DateTimeUtcFromMillis.annotate({ description: "When the next iteration becomes eligible for admission" }),
  ),
}).annotate({ identifier: "SessionLoop" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Updated = define({
  type: "loop.updated",
  schema: {
    sessionID: SessionID,
    loop: Schema.NullOr(Info),
  },
})

const Iterated = define({
  type: "loop.iterated",
  schema: {
    sessionID: SessionID,
    iterations: NonNegativeInt,
    nextRun: optional(DateTimeUtcFromMillis),
  },
})

export const Event = { Updated, Iterated, Definitions: inventory(Updated, Iterated) }
