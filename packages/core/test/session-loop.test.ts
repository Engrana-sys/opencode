import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionLoop } from "@opencode-ai/core/session/loop"
import { LoopTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionLoop.node])))
const sessionID = SessionV2.ID.make("ses_loop_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "loop",
      directory: "/project",
      title: "loop",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("SessionLoop.parseInterval", () => {
  it.effect("reads the durations a user would type", () =>
    Effect.sync(() => {
      expect(SessionLoop.parseInterval("30s")).toBe(30_000)
      expect(SessionLoop.parseInterval("5m")).toBe(300_000)
      expect(SessionLoop.parseInterval("2h")).toBe(7_200_000)
      expect(SessionLoop.parseInterval(" 5m ")).toBe(300_000)
    }),
  )

  it.effect("leaves anything else to be treated as prompt text", () =>
    Effect.sync(() => {
      // `/loop check the deploy` must not read "check" as a cadence.
      expect(SessionLoop.parseInterval("check")).toBeUndefined()
      expect(SessionLoop.parseInterval("5")).toBeUndefined()
      expect(SessionLoop.parseInterval("0m")).toBeUndefined()
      expect(SessionLoop.parseInterval("5 m")).toBeUndefined()
      expect(SessionLoop.parseInterval("")).toBeUndefined()
    }),
  )
})

describe("SessionLoop.clampDelay", () => {
  it.effect("keeps a loop from busy-spinning or stalling", () =>
    Effect.sync(() => {
      expect(SessionLoop.clampDelay(1_000)).toBe(SessionLoop.MIN_DELAY)
      expect(SessionLoop.clampDelay(86_400_000)).toBe(SessionLoop.MAX_DELAY)
      expect(SessionLoop.clampDelay(300_000)).toBe(300_000)
    }),
  )
})

describe("SessionLoop", () => {
  it.effect("runs its first iteration immediately and spaces the rest", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      const before = yield* DateTime.now

      const loop = yield* loops.set({ sessionID, prompt: "check the deploy", interval: 300_000, budget: 3 })
      expect(loop.status).toBe("active")
      expect(loop.iterations).toBe(0)
      // Due right away, so `/loop` acts on the first tick rather than after one interval.
      expect(yield* loops.due()).toHaveLength(1)

      const iterated = yield* loops.iterate({ sessionID })
      expect(iterated?.iterations).toBe(1)
      expect(yield* loops.due()).toHaveLength(0)
      expect(
        DateTime.toEpochMillis(iterated!.nextRun!) - DateTime.toEpochMillis(before),
      ).toBeGreaterThanOrEqual(300_000)
    }),
  )

  it.effect("stops itself once the budget runs out", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      yield* loops.set({ sessionID, prompt: "tick", interval: 60_000, budget: 2 })

      expect((yield* loops.iterate({ sessionID }))?.status).toBe("active")
      const last = yield* loops.iterate({ sessionID })
      expect(last?.status).toBe("exhausted")
      expect(last?.nextRun).toBeUndefined()
      expect(yield* loops.due()).toHaveLength(0)
    }),
  )

  it.effect("stopping clears the schedule and further iterations are inert", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      yield* loops.set({ sessionID, prompt: "tick", interval: 60_000 })

      const stopped = yield* loops.stop(sessionID)
      expect(stopped?.status).toBe("stopped")
      expect(yield* loops.due()).toHaveLength(0)
      expect((yield* loops.iterate({ sessionID }))?.iterations).toBe(0)
    }),
  )

  it.effect("a self-paced loop can move its own next run", () =>
    Effect.gen(function* () {
      yield* setup
      const loops = yield* SessionLoop.Service
      yield* loops.set({ sessionID, prompt: "watch CI" })
      yield* loops.iterate({ sessionID })
      expect(yield* loops.due()).toHaveLength(0)

      const now = yield* DateTime.now
      const rescheduled = yield* loops.reschedule({ sessionID, delay: 120_000 })
      expect(DateTime.toEpochMillis(rescheduled!.nextRun!) - DateTime.toEpochMillis(now)).toBeGreaterThanOrEqual(
        120_000,
      )
      // Rescheduling is not an iteration; it must not spend the budget.
      expect(rescheduled?.iterations).toBe(1)
    }),
  )
})

describe("SessionLoop.claim", () => {
  it.effect("hands one due iteration to a single ticker", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const loops = yield* SessionLoop.Service
      yield* loops.set({ sessionID, prompt: "tick", interval: 300_000, budget: 3 })
      const row = yield* db
        .select()
        .from(LoopTable)
        .where(eq(LoopTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)

      // Every opencode server polls the same machine-global table, so two ticks
      // routinely read the same row as due before either has written.
      expect(yield* SessionLoop.claim(db, row!)).toBe(true)
      expect(yield* SessionLoop.claim(db, row!)).toBe(false)

      // The schedule moves before the work, so failing part-way through loses
      // the iteration rather than re-admitting its prompt on every tick.
      expect(yield* loops.due()).toHaveLength(0)
      expect((yield* loops.get(sessionID))?.iterations).toBe(0)
    }),
  )

  it.effect("leaves a stopped loop alone", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const loops = yield* SessionLoop.Service
      yield* loops.set({ sessionID, prompt: "tick", interval: 60_000 })
      const row = yield* db
        .select()
        .from(LoopTable)
        .where(eq(LoopTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      yield* loops.stop(sessionID)

      expect(yield* SessionLoop.claim(db, row!)).toBe(false)
    }),
  )
})
