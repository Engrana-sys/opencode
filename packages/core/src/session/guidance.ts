export * as SessionGuidance from "./guidance"

import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SystemContext } from "../system-context/index"
import { SessionGoal } from "./goal"
import { SessionLoop } from "./loop"
import { SessionSchema } from "./schema"
import { SessionTodo } from "./todo"

/**
 * Projects durable session state into system context.
 *
 * Compaction rewrites conversational history through a model, so anything that
 * only exists as a message degrades a little on every epoch. These sources are
 * re-rendered verbatim from the database at the start of each Context Epoch,
 * which makes them the one part of a long session that never drifts.
 *
 * @module
 */

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * Only the fields whose change should reach the model. Progress counters move
 * on every turn and would otherwise emit a system message each time.
 */
const GoalSummary = Schema.Struct({ condition: Schema.String })
type GoalSummary = typeof GoalSummary.Type

const LoopSummary = Schema.Struct({
  prompt: Schema.String,
  interval: Schema.NullOr(Schema.Int),
})
type LoopSummary = typeof LoopSummary.Type

const cadence = (interval: number | null) => {
  if (interval === null) return "self-paced: you choose the delay before each iteration"
  if (interval % 3_600_000 === 0) return `every ${interval / 3_600_000}h`
  if (interval % 60_000 === 0) return `every ${interval / 60_000}m`
  return `every ${Math.round(interval / 1_000)}s`
}

const renderGoal = (goal: GoalSummary) =>
  [
    "<goal>",
    `  ${escape(goal.condition)}`,
    "</goal>",
    "The user set this goal. Keep working until the condition above holds, and do not stop to report intermediate progress or ask whether to continue.",
    "An independent evaluator checks the condition after each of your turns, so state plainly what you did and what evidence shows the condition holds.",
  ].join("\n")

const renderTodos = (todos: ReadonlyArray<SessionTodo.Info>) =>
  [
    "<todos>",
    ...todos.map(
      (todo) => `  <todo status="${todo.status}" priority="${todo.priority}">${escape(todo.content)}</todo>`,
    ),
    "</todos>",
    "This is the durable task list for this session and it is authoritative: it survives compaction, while the conversation above may not. Trust it over your recollection of what is done.",
  ].join("\n")

const renderLoop = (loop: LoopSummary) =>
  [
    "<loop>",
    `  <prompt>${escape(loop.prompt)}</prompt>`,
    `  <cadence>${cadence(loop.interval)}</cadence>`,
    "</loop>",
    "This session is running on a loop. The prompt above is re-admitted on the cadence shown, so treat a repeat of it as the next scheduled iteration rather than as the user asking again.",
    ...(loop.interval === null
      ? ["Before ending an iteration, call the loop_schedule tool to set the delay before the next one."]
      : []),
  ].join("\n")

export interface Interface {
  readonly load: (sessionID: SessionSchema.ID) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionGuidance") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const goals = yield* SessionGoal.Service
    const loops = yield* SessionLoop.Service
    const todos = yield* SessionTodo.Service

    return Service.of({
      load: Effect.fn("SessionGuidance.load")(function* (sessionID) {
        const [goal, loop, list] = yield* Effect.all(
          [goals.get(sessionID), loops.get(sessionID), todos.get(sessionID)],
          { concurrency: "unbounded" },
        )
        return SystemContext.combine([
          goal === undefined || goal.status !== "active"
            ? SystemContext.empty
            : SystemContext.make({
                key: SystemContext.Key.make("core/goal"),
                codec: Schema.toCodecJson(GoalSummary),
                load: Effect.succeed({ condition: goal.condition }),
                baseline: renderGoal,
                update: (_previous, current) =>
                  ["The goal has changed. It supersedes the previous goal.", renderGoal(current)].join("\n"),
                removed: () =>
                  "The goal is no longer active. It was achieved, cleared by the user, or ran out of budget. Stop working toward it and wait for the user.",
              }),
          list.length === 0
            ? SystemContext.empty
            : SystemContext.make({
                key: SystemContext.Key.make("core/todos"),
                codec: Schema.toCodecJson(Schema.Array(SessionTodo.Info)),
                load: Effect.succeed(list),
                baseline: renderTodos,
                update: (_previous, current) =>
                  ["The task list has changed. It supersedes the previous list.", renderTodos(current)].join("\n"),
                removed: () => "The task list is now empty.",
              }),
          loop === undefined || loop.status !== "active"
            ? SystemContext.empty
            : SystemContext.make({
                key: SystemContext.Key.make("core/loop"),
                codec: Schema.toCodecJson(LoopSummary),
                load: Effect.succeed({ prompt: loop.prompt, interval: loop.interval ?? null }),
                baseline: renderLoop,
                update: (_previous, current) =>
                  ["The loop has changed. It supersedes the previous loop.", renderLoop(current)].join("\n"),
                removed: () => "The loop is no longer running. Do not expect its prompt to repeat.",
              }),
        ])
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [SessionGoal.node, SessionLoop.node, SessionTodo.node],
})
