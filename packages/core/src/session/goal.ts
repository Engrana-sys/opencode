export * as SessionGoal from "./goal"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { SessionGoal } from "@opencode-ai/schema/session-goal"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"
import { GoalTable } from "./sql"

export const Info = SessionGoal.Info
export type Info = typeof Info.Type
export const Status = SessionGoal.Status
export type Status = typeof Status.Type
export const Event = SessionGoal.Event

/** Continuations a goal may spend before it stops on its own. */
export const DEFAULT_BUDGET = 20

const fromRow = (row: typeof GoalTable.$inferSelect): Info => ({
  condition: row.condition,
  status: row.status,
  iterations: row.iterations,
  budget: row.budget,
  ...(row.verdict === null ? {} : { verdict: row.verdict }),
})

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  /** Replaces any existing goal with a fresh active one. */
  readonly set: (input: {
    readonly sessionID: SessionSchema.ID
    readonly condition: string
    readonly budget?: number
  }) => Effect.Effect<Info>
  /** Settles an active goal without consuming an iteration. */
  readonly settle: (input: {
    readonly sessionID: SessionSchema.ID
    readonly status: Exclude<Status, "active">
    readonly verdict?: string
  }) => Effect.Effect<Info | undefined>
  /** Records one evaluated continuation and returns the goal as it now stands. */
  readonly record: (input: {
    readonly sessionID: SessionSchema.ID
    readonly met: boolean
    readonly verdict: string
  }) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionGoal") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const read = Effect.fn("SessionGoal.read")(function* (sessionID: SessionSchema.ID) {
      const row = yield* db
        .select()
        .from(GoalTable)
        .where(eq(GoalTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row === undefined ? undefined : fromRow(row)
    })

    const publish = Effect.fn("SessionGoal.publish")(function* (
      sessionID: SessionSchema.ID,
      goal: Info | undefined,
    ) {
      yield* events.publish(Event.Updated, { sessionID, goal: goal ?? null })
      return goal
    })

    const set = Effect.fn("SessionGoal.set")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly condition: string
      readonly budget?: number
    }) {
      const goal: Info = {
        condition: input.condition,
        status: "active",
        iterations: 0,
        budget: input.budget ?? DEFAULT_BUDGET,
      }
      yield* db
        .insert(GoalTable)
        .values({
          session_id: input.sessionID,
          condition: goal.condition,
          status: goal.status,
          iterations: goal.iterations,
          budget: goal.budget,
          verdict: null,
        })
        .onConflictDoUpdate({
          target: GoalTable.session_id,
          set: {
            condition: goal.condition,
            status: goal.status,
            iterations: goal.iterations,
            budget: goal.budget,
            verdict: null,
            time_updated: Date.now(),
          },
        })
        .run()
        .pipe(Effect.orDie)
      yield* publish(input.sessionID, goal)
      return goal
    })

    const settle = Effect.fn("SessionGoal.settle")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly status: Exclude<Status, "active">
      readonly verdict?: string
    }) {
      const current = yield* read(input.sessionID)
      if (current === undefined || current.status !== "active") return current
      const goal: Info = {
        ...current,
        status: input.status,
        ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
      }
      yield* db
        .update(GoalTable)
        .set({
          status: goal.status,
          ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
          time_updated: Date.now(),
        })
        .where(eq(GoalTable.session_id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      return yield* publish(input.sessionID, goal)
    })

    const record = Effect.fn("SessionGoal.record")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly met: boolean
      readonly verdict: string
    }) {
      const current = yield* read(input.sessionID)
      if (current === undefined || current.status !== "active") return current
      const iterations = current.iterations + 1
      const goal: Info = {
        ...current,
        iterations,
        verdict: input.verdict,
        status: input.met ? "achieved" : iterations >= current.budget ? "exhausted" : "active",
      }
      yield* db
        .update(GoalTable)
        .set({
          iterations: goal.iterations,
          verdict: goal.verdict,
          status: goal.status,
          time_updated: Date.now(),
        })
        .where(eq(GoalTable.session_id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(Event.Evaluated, {
        sessionID: input.sessionID,
        met: input.met,
        verdict: input.verdict,
        iterations,
      })
      return yield* publish(input.sessionID, goal)
    })

    return Service.of({ get: read, set, settle, record })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
