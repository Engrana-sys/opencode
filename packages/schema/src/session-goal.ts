export * as SessionGoal from "./session-goal"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { NonNegativeInt, optional, PositiveInt } from "./schema"
import { SessionID } from "./session-id"

export const Status = Schema.Literals(["active", "achieved", "abandoned", "exhausted"]).annotate({
  identifier: "SessionGoal.Status",
})
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  condition: Schema.String.annotate({
    description: "The condition that must hold before the session stops working on its own",
  }),
  status: Status.annotate({
    description:
      "active while the condition is still being pursued, achieved once the evaluator confirmed it, abandoned when cleared by the user, exhausted when the iteration budget ran out",
  }),
  iterations: NonNegativeInt.annotate({
    description: "Number of continuations the goal has already spent",
  }),
  budget: PositiveInt.annotate({
    description: "Maximum number of continuations the goal may spend before it is exhausted",
  }),
  verdict: optional(
    Schema.String.annotate({ description: "The evaluator's reason for the most recent continuation or stop" }),
  ),
}).annotate({ identifier: "SessionGoal" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Updated = define({
  type: "goal.updated",
  schema: {
    sessionID: SessionID,
    goal: Schema.NullOr(Info),
  },
})

const Evaluated = define({
  type: "goal.evaluated",
  schema: {
    sessionID: SessionID,
    met: Schema.Boolean,
    verdict: Schema.String,
    iterations: NonNegativeInt,
  },
})

export const Event = { Updated, Evaluated, Definitions: inventory(Updated, Evaluated) }
