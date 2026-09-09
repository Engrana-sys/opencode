export * as SessionLoopScheduler from "./loop-scheduler"

import { and, eq, isNotNull, lte } from "drizzle-orm"
import { DateTime, Effect, Layer, Schedule } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { LocationServiceMap } from "../location-service-map"
import { SessionExecution } from "./execution"
import { SessionInput } from "./input"
import { SessionLoop } from "./loop"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { LoopTable } from "./sql"
import { SessionStore } from "./store"

/**
 * Admits due loop iterations.
 *
 * A loop is durable state rather than a held timer, so nothing is lost when the
 * process restarts mid-interval: the next tick finds the iteration overdue and
 * admits it. Admission goes to the queue, so an iteration waits for whatever
 * the session is already doing instead of interrupting it.
 *
 * Scheduling is global because waking a session is, while the loop record
 * itself belongs to the session's Location; each due row is settled through
 * that Location's own service.
 *
 * @module
 */

const TICK = "15 seconds"

const scheduler = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service

    const admit = Effect.fn("SessionLoopScheduler.admit")(function* (row: typeof LoopTable.$inferSelect) {
      const sessionID = SessionSchema.ID.make(row.session_id)
      const session = yield* store.get(sessionID)
      if (!session) return
      // The iteration is charged before the prompt is queued: admitting first
      // and failing to record leaves a loop running against a budget it never
      // spends, while a recorded iteration that failed to queue costs one turn.
      const iterated = yield* Effect.gen(function* () {
        const loops = yield* SessionLoop.Service
        return yield* loops.iterate({ sessionID })
      }).pipe(Effect.provide(locations.get(session.location)))
      // A loop stopped or replaced since the claim spent nothing, and the work
      // it would queue is work the user has already called off.
      if (iterated?.iterations !== row.iterations + 1) return
      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID,
        prompt: Prompt.fromUserMessage({ text: row.prompt }),
        delivery: "queue",
      })
      yield* execution.wake(sessionID)
    })

    const tick = Effect.fn("SessionLoopScheduler.tick")(function* () {
      const due = yield* db
        .select()
        .from(LoopTable)
        .where(
          and(
            eq(LoopTable.status, "active"),
            isNotNull(LoopTable.next_run),
            lte(LoopTable.next_run, DateTime.toEpochMillis(yield* DateTime.now)),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      for (const row of due) {
        // One session's failure must not stop the others from iterating.
        yield* Effect.gen(function* () {
          // Whoever takes the row runs the iteration; every other ticker, here
          // or in another opencode server on this machine, leaves it alone.
          if (yield* SessionLoop.claim(db, row)) yield* admit(row)
        }).pipe(Effect.catchCause((cause) => Effect.logWarning(`Loop iteration failed for ${row.session_id}`, cause)))
      }
    })

    yield* tick().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Loop scheduler tick failed", cause)),
      Effect.repeat(Schedule.spaced(TICK)),
      Effect.forkScoped,
    )
  }),
)

export const node = makeGlobalNode({
  name: "session-loop-scheduler",
  layer: scheduler,
  deps: [Database.node, EventV2.node, SessionExecution.node, SessionStore.node, LocationServiceMap.node],
})
