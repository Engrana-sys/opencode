export * as LoopScheduleTool from "./loop-schedule"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PositiveInt } from "../schema"
import { SessionLoop } from "../session/loop"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "loop_schedule"

export const Input = Schema.Struct({
  delaySeconds: PositiveInt.annotate({
    description:
      "Seconds until the next iteration. Clamped to between 60 and 3600. Match it to what you are waiting on: a check that takes ten minutes deserves one wait of 600, not ten of 60",
  }),
  reason: Schema.String.annotate({
    description: "One short sentence on what you are waiting for. Shown to the user",
  }),
})

export const Output = Schema.Struct({
  delaySeconds: Schema.Int,
})
export type Output = typeof Output.Type

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const loops = yield* SessionLoop.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Set how long this self-paced loop waits before its next iteration. Call it once before ending an iteration of a loop whose cadence is self-paced. It has no effect on a loop running at a fixed interval, and none when no loop is running.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            { type: "text", text: `Next iteration in ${output.delaySeconds} seconds.` },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const loop = yield* loops.reschedule({
                sessionID: context.sessionID,
                delay: input.delaySeconds * 1_000,
              })
              if (loop === undefined || loop.status !== "active")
                return yield* new ToolFailure({ message: "No loop is running in this session" })
              return { delaySeconds: Math.round(SessionLoop.clampDelay(input.delaySeconds * 1_000) / 1_000) }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/loop-schedule",
  layer,
  deps: [ToolRegistry.node, SessionLoop.node],
})
