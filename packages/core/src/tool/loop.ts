export * as LoopTool from "./loop"

import { ToolFailure } from "@opencode-ai/llm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PositiveInt } from "../schema"
import { SessionLoop } from "../session/loop"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "loop"

export const Input = Schema.Struct({
  action: Schema.Literals(["start", "show", "stop"]).annotate({
    description: "start begins a recurring prompt, show reports the current loop, stop ends it",
  }),
  prompt: Schema.String.pipe(Schema.optional).annotate({
    description: "Required for start. The prompt to re-run on each iteration",
  }),
  intervalSeconds: PositiveInt.pipe(Schema.optional).annotate({
    description:
      "Seconds between iterations. Omit to make the loop self-paced, choosing each delay with the loop_schedule tool. Clamped to between 60 and 3600",
  }),
  budget: PositiveInt.pipe(Schema.optional).annotate({
    description: "Optional cap on iterations before the loop stops. Defaults to 100",
  }),
})

/** A plain projection of a loop: the tool result carries no DateTime transformation. */
export const Summary = Schema.Struct({
  prompt: Schema.String,
  cadence: Schema.String,
  iterations: Schema.Int,
  budget: Schema.Int,
  status: SessionLoop.Status,
  nextRun: Schema.NullOr(Schema.String),
})
export type Summary = typeof Summary.Type

export const Output = Schema.Struct({
  loop: Schema.NullOr(Summary),
})
export type Output = typeof Output.Type

export const summarize = (loop: SessionLoop.Info | undefined): Summary | null =>
  loop === undefined
    ? null
    : {
        prompt: loop.prompt,
        cadence: loop.interval === undefined ? "self-paced" : `every ${Math.round(loop.interval / 1_000)}s`,
        iterations: loop.iterations,
        budget: loop.budget,
        status: loop.status,
        nextRun: loop.nextRun === undefined ? null : DateTime.formatIso(loop.nextRun),
      }

export const describe = (loop: Summary | null) => {
  if (loop === null) return "No loop is running in this session."
  return [
    `Loop (${loop.status}), ${loop.cadence}: ${loop.prompt}`,
    `${loop.iterations} of ${loop.budget} iterations run`,
    ...(loop.nextRun === null ? [] : [`Next iteration at ${loop.nextRun}`]),
  ].join("\n")
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const loops = yield* SessionLoop.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Start, inspect, or stop a recurring prompt for this session. Each iteration is queued rather than forced, so it waits for whatever the session is already doing. Use it for work driven by the clock, such as polling a deploy or re-checking a build; use the goal tool instead when the session should stop on proof rather than on a schedule. A loop survives restarts.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: describe(output.loop) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.action === "show") return { loop: summarize(yield* loops.get(context.sessionID)) }
              if (input.action === "stop") {
                yield* loops.stop(context.sessionID)
                return { loop: summarize(yield* loops.get(context.sessionID)) }
              }
              if (input.prompt === undefined || input.prompt.trim().length === 0)
                return yield* new ToolFailure({ message: "Starting a loop requires a prompt" })
              return {
                loop: summarize(
                  yield* loops.set({
                    sessionID: context.sessionID,
                    prompt: input.prompt.trim(),
                    ...(input.intervalSeconds === undefined
                      ? {}
                      : { interval: SessionLoop.clampDelay(input.intervalSeconds * 1_000) }),
                    ...(input.budget === undefined ? {} : { budget: input.budget }),
                  }),
                ),
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool/loop", layer, deps: [ToolRegistry.node, SessionLoop.node] })
