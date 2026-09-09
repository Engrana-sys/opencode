import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionGoal } from "@opencode-ai/core/session/goal"
import { SessionGoalEvaluator } from "@opencode-ai/core/session/goal-evaluator"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionGoal.node])))
const sessionID = SessionV2.ID.make("ses_goal_test")

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
      slug: "goal",
      directory: "/project",
      title: "goal",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("SessionGoal", () => {
  it.effect("spends its budget and then stops on its own", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* SessionGoal.Service
      expect(yield* goals.get(sessionID)).toBeUndefined()

      yield* goals.set({ sessionID, condition: "the tests pass", budget: 2 })
      expect(yield* goals.get(sessionID)).toEqual({
        condition: "the tests pass",
        status: "active",
        iterations: 0,
        budget: 2,
      })

      const first = yield* goals.record({ sessionID, met: false, verdict: "two tests still fail" })
      expect(first?.status).toBe("active")
      expect(first?.iterations).toBe(1)

      const second = yield* goals.record({ sessionID, met: false, verdict: "one test still fails" })
      expect(second?.status).toBe("exhausted")
      expect(second?.iterations).toBe(2)

      // A settled goal absorbs further evaluations rather than reviving.
      expect(yield* goals.record({ sessionID, met: true, verdict: "late" })).toEqual(second!)
    }),
  )

  it.effect("stops as soon as the condition is met", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* SessionGoal.Service
      yield* goals.set({ sessionID, condition: "the build succeeds", budget: 10 })

      const recorded = yield* goals.record({ sessionID, met: true, verdict: "bun run build exited 0" })
      expect(recorded?.status).toBe("achieved")
      expect(recorded?.verdict).toBe("bun run build exited 0")
    }),
  )

  it.effect("replaces an existing goal and clears its progress", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* SessionGoal.Service
      yield* goals.set({ sessionID, condition: "first", budget: 5 })
      yield* goals.record({ sessionID, met: false, verdict: "not yet" })

      const replaced = yield* goals.set({ sessionID, condition: "second", budget: 5 })
      expect(replaced).toEqual({ condition: "second", status: "active", iterations: 0, budget: 5 })
      expect((yield* goals.get(sessionID))?.verdict).toBeUndefined()
    }),
  )

  it.effect("clearing a goal leaves it settled and readable", () =>
    Effect.gen(function* () {
      yield* setup
      const goals = yield* SessionGoal.Service
      yield* goals.set({ sessionID, condition: "keep going", budget: 5 })
      yield* goals.settle({ sessionID, status: "abandoned", verdict: "cleared by the user" })

      const goal = yield* goals.get(sessionID)
      expect(goal?.status).toBe("abandoned")
      expect(goal?.condition).toBe("keep going")
    }),
  )
})

describe("SessionGoalEvaluator.parseVerdict", () => {
  it.effect("reads both verdicts and their reason", () =>
    Effect.sync(() => {
      expect(SessionGoalEvaluator.parseVerdict("VERDICT: MET\nREASON: bun test reported 12 pass, 0 fail")).toEqual({
        evaluated: true,
        met: true,
        reason: "bun test reported 12 pass, 0 fail",
      })
      expect(SessionGoalEvaluator.parseVerdict("VERDICT: NOT_MET\nREASON: no test run appears")).toEqual({
        evaluated: true,
        met: false,
        reason: "no test run appears",
      })
    }),
  )

  it.effect("tolerates spacing and surrounding prose", () =>
    Effect.sync(() => {
      expect(SessionGoalEvaluator.parseVerdict("Here is my answer.\n\nverdict:  not met\nreason:   still failing")).toEqual(
        { evaluated: true, met: false, reason: "still failing" },
      )
    }),
  )

  it.effect("rejects output with no verdict so the chain moves on", () =>
    Effect.sync(() => {
      expect(SessionGoalEvaluator.parseVerdict("I think it looks fine to me")).toBeUndefined()
      expect(SessionGoalEvaluator.parseVerdict("")).toBeUndefined()
    }),
  )

  it.effect("ignores a judge that echoes the answer format before answering", () =>
    Effect.sync(() => {
      // The instructions themselves contain "VERDICT: MET or NOT_MET", so a
      // restated format must not be read as the verdict.
      expect(
        SessionGoalEvaluator.parseVerdict(
          "I will respond with VERDICT: MET or NOT_MET as required.\nVERDICT: NOT_MET\nREASON: tests still fail",
        ),
      ).toEqual({ evaluated: true, met: false, reason: "tests still fail" })
    }),
  )

  it.effect("defaults the reason when the model omits it", () =>
    Effect.sync(() => {
      expect(SessionGoalEvaluator.parseVerdict("VERDICT: MET")?.reason).toBe("No reason given.")
    }),
  )
})

describe("SessionGoalEvaluator.selectTranscript", () => {
  const message = (text: string) =>
    SessionMessage.User.make({
      id: SessionMessage.ID.make("msg_transcript"),
      type: "user",
      text,
      time: { created: DateTime.makeUnsafe(0) },
    })

  it.effect("keeps the newest message even when it alone exceeds the budget", () =>
    Effect.sync(() => {
      // A single `write` call or a pasted log outgrows the whole budget; an
      // empty transcript would read as no evidence and cost a continuation.
      const transcript = SessionGoalEvaluator.selectTranscript([message("older work"), message("x".repeat(80_000))])
      expect(transcript).toContain("xxx")
      expect(transcript).not.toContain("older work")
      expect(transcript.length).toBeLessThan(80_000)
    }),
  )

  it.effect("still keeps whole messages when they fit", () =>
    Effect.sync(() => {
      expect(SessionGoalEvaluator.selectTranscript([message("first"), message("second")])).toBe(
        "[User]: first\n\n[User]: second",
      )
      expect(SessionGoalEvaluator.selectTranscript([])).toBe("")
    }),
  )
})
