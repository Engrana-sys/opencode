export * as SessionLoop from "./loop"

import { and, eq, isNotNull, lte } from "drizzle-orm"
import { Context, DateTime, Effect, Layer } from "effect"
import { SessionLoop } from "@opencode-ai/schema/session-loop"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"
import { LoopTable } from "./sql"

export const Info = SessionLoop.Info
export type Info = typeof Info.Type
export const Status = SessionLoop.Status
export type Status = typeof Status.Type
export const Event = SessionLoop.Event

/** Iterations a loop may run before it stops on its own. */
export const DEFAULT_BUDGET = 100
/** Delay applied to a self-paced loop when the model does not choose one itself. */
export const DEFAULT_SELF_PACED_DELAY = 1_200_000
/** Bounds a self-paced delay so a loop can neither busy-spin nor stall for a day. */
export const MIN_DELAY = 60_000
export const MAX_DELAY = 3_600_000

export const clampDelay = (milliseconds: number) => Math.min(MAX_DELAY, Math.max(MIN_DELAY, milliseconds))

/**
 * Parses a duration suffixed with s, m, or h. Returns undefined for anything
 * else so a bare `/loop <prompt>` keeps its whole argument as the prompt.
 */
export const parseInterval = (value: string) => {
  const match = /^(\d+)(s|m|h)$/.exec(value.trim())
  if (!match) return undefined
  const amount = Number(match[1])
  if (amount <= 0) return undefined
  return amount * (match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000)
}

/**
 * Takes a due row for one iteration by moving `next_run` forward in a single
 * compare-and-set, and reports whether this caller won it.
 *
 * The loop table is machine-global while every opencode server runs its own
 * ticker, so the row itself is the only place two ticks can agree on who runs
 * an iteration. Moving the schedule before any of the work also bounds a
 * failure part-way through: the iteration is lost rather than re-admitted on
 * every tick forever, against a budget that is never spent.
 */
export const claim = Effect.fn("SessionLoop.claim")(function* (
  db: Database.Interface["db"],
  row: typeof LoopTable.$inferSelect,
) {
  if (row.next_run === null) return false
  const nextRun = DateTime.addDuration(yield* DateTime.now, clampDelay(row.interval ?? DEFAULT_SELF_PACED_DELAY))
  const claimed = yield* db
    .update(LoopTable)
    .set({ next_run: DateTime.toEpochMillis(nextRun), time_updated: Date.now() })
    .where(
      and(
        eq(LoopTable.session_id, row.session_id),
        eq(LoopTable.status, "active"),
        eq(LoopTable.next_run, row.next_run),
      ),
    )
    .returning({ session_id: LoopTable.session_id })
    .get()
    .pipe(Effect.orDie)
  return claimed !== undefined
})

const fromRow = (row: typeof LoopTable.$inferSelect): Info => ({
  prompt: row.prompt,
  ...(row.interval === null ? {} : { interval: row.interval }),
  iterations: row.iterations,
  budget: row.budget,
  status: row.status,
  ...(row.next_run === null ? {} : { nextRun: DateTime.makeUnsafe(row.next_run) }),
})

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  /** Replaces any existing loop with a fresh active one. */
  readonly set: (input: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: string
    readonly interval?: number
    readonly budget?: number
  }) => Effect.Effect<Info>
  readonly stop: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  /** Records one admitted iteration and schedules the next one at the loop's own cadence. */
  readonly iterate: (input: { readonly sessionID: SessionSchema.ID }) => Effect.Effect<Info | undefined>
  /** Moves the next iteration without consuming one, for a self-paced loop choosing its own delay. */
  readonly reschedule: (input: {
    readonly sessionID: SessionSchema.ID
    readonly delay: number
  }) => Effect.Effect<Info | undefined>
  /** Active loops whose next iteration is already due. */
  readonly due: () => Effect.Effect<ReadonlyArray<{ readonly sessionID: SessionSchema.ID; readonly loop: Info }>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionLoop") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const read = Effect.fn("SessionLoop.read")(function* (sessionID: SessionSchema.ID) {
      const row = yield* db
        .select()
        .from(LoopTable)
        .where(eq(LoopTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row === undefined ? undefined : fromRow(row)
    })

    const publish = Effect.fn("SessionLoop.publish")(function* (sessionID: SessionSchema.ID, loop: Info | undefined) {
      yield* events.publish(Event.Updated, { sessionID, loop: loop ?? null })
      return loop
    })

    const set = Effect.fn("SessionLoop.set")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly prompt: string
      readonly interval?: number
      readonly budget?: number
    }) {
      // The first iteration runs immediately; the interval spaces the ones after it.
      const nextRun = yield* DateTime.now
      const loop: Info = {
        prompt: input.prompt,
        ...(input.interval === undefined ? {} : { interval: input.interval }),
        iterations: 0,
        budget: input.budget ?? DEFAULT_BUDGET,
        status: "active",
        nextRun,
      }
      const values = {
        session_id: input.sessionID,
        prompt: loop.prompt,
        interval: input.interval ?? null,
        iterations: 0,
        budget: loop.budget,
        status: loop.status,
        next_run: DateTime.toEpochMillis(nextRun),
      }
      yield* db
        .insert(LoopTable)
        .values(values)
        .onConflictDoUpdate({
          target: LoopTable.session_id,
          set: { ...values, time_updated: Date.now() },
        })
        .run()
        .pipe(Effect.orDie)
      yield* publish(input.sessionID, loop)
      return loop
    })

    const stop = Effect.fn("SessionLoop.stop")(function* (sessionID: SessionSchema.ID) {
      const current = yield* read(sessionID)
      if (current === undefined || current.status !== "active") return current
      yield* db
        .update(LoopTable)
        .set({ status: "stopped", next_run: null, time_updated: Date.now() })
        .where(eq(LoopTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const loop: Info = { ...current, status: "stopped", nextRun: undefined }
      return yield* publish(sessionID, loop)
    })

    const iterate = Effect.fn("SessionLoop.iterate")(function* (input: { readonly sessionID: SessionSchema.ID }) {
      const current = yield* read(input.sessionID)
      if (current === undefined || current.status !== "active") return current
      const iterations = current.iterations + 1
      const exhausted = iterations >= current.budget
      const nextRun = exhausted
        ? undefined
        : DateTime.addDuration(yield* DateTime.now, clampDelay(current.interval ?? DEFAULT_SELF_PACED_DELAY))
      yield* db
        .update(LoopTable)
        .set({
          iterations,
          status: exhausted ? "exhausted" : "active",
          next_run: nextRun === undefined ? null : DateTime.toEpochMillis(nextRun),
          time_updated: Date.now(),
        })
        .where(eq(LoopTable.session_id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      const loop: Info = {
        ...current,
        iterations,
        status: exhausted ? "exhausted" : "active",
        nextRun,
      }
      yield* events.publish(Event.Iterated, {
        sessionID: input.sessionID,
        iterations,
        ...(nextRun === undefined ? {} : { nextRun }),
      })
      return yield* publish(input.sessionID, loop)
    })

    const reschedule = Effect.fn("SessionLoop.reschedule")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly delay: number
    }) {
      const current = yield* read(input.sessionID)
      if (current === undefined || current.status !== "active") return current
      const nextRun = DateTime.addDuration(yield* DateTime.now, clampDelay(input.delay))
      yield* db
        .update(LoopTable)
        .set({ next_run: DateTime.toEpochMillis(nextRun), time_updated: Date.now() })
        .where(eq(LoopTable.session_id, input.sessionID))
        .run()
        .pipe(Effect.orDie)
      return yield* publish(input.sessionID, { ...current, nextRun })
    })

    const due = Effect.fn("SessionLoop.due")(function* () {
      const now = yield* DateTime.now
      const rows = yield* db
        .select()
        .from(LoopTable)
        .where(
          and(
            eq(LoopTable.status, "active"),
            isNotNull(LoopTable.next_run),
            lte(LoopTable.next_run, DateTime.toEpochMillis(now)),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({ sessionID: SessionSchema.ID.make(row.session_id), loop: fromRow(row) }))
    })

    return Service.of({ get: read, set, stop, iterate, reschedule, due })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
