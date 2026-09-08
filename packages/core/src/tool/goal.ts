export * as GoalTool from "./goal"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PositiveInt } from "../schema"
import { SessionGoal } from "../session/goal"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "goal"

export const Input = Schema.Struct({
  action: Schema.Literals(["set", "show", "clear"]).annotate({
    description: "set records a new goal, show reports the current one, clear stops pursuing it",
  }),
  condition: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Required for set. The condition that must hold before the session stops, stated so someone reading only the transcript could check it. Prefer something observable: a command that exits zero, a test that passes, a file that contains something",
  }),
  budget: PositiveInt.pipe(Schema.optional).annotate({
    description: "Optional cap on continuations before the goal gives up. Defaults to 20",
  }),
})

export const Output = Schema.Struct({
  goal: Schema.NullOr(SessionGoal.Info),
})
export type Output = typeof Output.Type

export const describe = (goal: SessionGoal.Info | null) => {
  if (goal === null) return "No goal has been set for this session."
  const progress = `${goal.iterations} of ${goal.budget} continuations spent`
  const verdict = goal.verdict === undefined ? [] : [`Last verdict: ${goal.verdict}`]
  return [`Goal (${goal.status}): ${goal.condition}`, progress, ...verdict].join("\n")
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const goals = yield* SessionGoal.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Record, inspect, or clear this session's goal: a condition to keep working toward across turns. After each turn an independent evaluator checks the condition against the transcript, and the session keeps going until it holds or the budget runs out. Set one when the user asks you to work until something is true rather than to perform one specific edit. The goal survives compaction, so it is also how a long session keeps hold of what it is for.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: describe(output.goal) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.action === "show") return { goal: (yield* goals.get(context.sessionID)) ?? null }
              if (input.action === "clear") {
                yield* goals.settle({
                  sessionID: context.sessionID,
                  status: "abandoned",
                  verdict: "Cleared before the condition was met.",
                })
                return { goal: (yield* goals.get(context.sessionID)) ?? null }
              }
              if (input.condition === undefined || input.condition.trim().length === 0)
                return yield* new ToolFailure({ message: "Setting a goal requires a condition" })
              return {
                goal: yield* goals.set({
                  sessionID: context.sessionID,
                  condition: input.condition.trim(),
                  ...(input.budget === undefined ? {} : { budget: input.budget }),
                }),
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool/goal", layer, deps: [ToolRegistry.node, SessionGoal.node] })
