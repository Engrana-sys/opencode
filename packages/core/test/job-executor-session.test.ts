import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { JobExecutor } from "@opencode-ai/core/job/executor"
import { JobExecutorSession } from "@opencode-ai/core/job/executor-session"
import { SessionV2 } from "@opencode-ai/core/session"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import { it as effect } from "./lib/effect"

const job = { objective: "find billing bugs in the voice service" }
const worker = { role: "scout-backend" }

describe("JobExecutorSession.brief", () => {
  it("gives the worker its role and the job's objective", () => {
    const text = JobExecutorSession.brief({ job, worker })
    expect(text).toContain("scout-backend")
    expect(text).toContain("find billing bugs in the voice service")
  })

  it("asks the worker to say what it could not establish", () => {
    // A scout that reports only what it found, and stays quiet about what it
    // could not check, produces an audit that reads as more complete than it is.
    expect(JobExecutorSession.brief({ job, worker })).toContain("could not establish")
  })
})

/** A session that ran for a while, whatever the attempt did with it afterwards. */
const info = {
  id: "ses_worker",
  model: { providerID: "mistral", id: "codestral-2508" },
  cost: 3.1,
  tokens: { input: 240_000, output: 30_000, reasoning: 0, cache: { read: 4_000, write: 1_000 } },
} as unknown as SessionSchema.Info

const sessions = (failure?: string) =>
  Layer.succeed(
    SessionV2.Service,
    SessionV2.Service.of({
      create: () => Effect.succeed(info),
      prompt: () => Effect.void,
      resume: () => (failure === undefined ? Effect.void : Effect.fail(new Error(failure))),
      get: () => Effect.succeed(info),
    } as unknown as SessionV2.Interface),
  )

/** Captures where each session was asked to run, so a test can assert on it. */
const created: { location?: { directory?: string } }[] = []
const recording = () => {
  created.length = 0
  return Layer.succeed(
    SessionV2.Service,
    SessionV2.Service.of({
      create: (arg: { location?: { directory?: string } }) => {
        created.push(arg)
        return Effect.succeed(info)
      },
      prompt: () => Effect.void,
      resume: () => Effect.void,
      get: () => Effect.succeed(info),
    } as unknown as SessionV2.Interface),
  )
}

const input = {
  job: { directory: "/project", objective: "audit the thing" },
  worker: { id: "wrk_one", role: "fixer", agent: "build" },
  attempt: { id: "att_one", requested: { providerID: "mistral", modelID: "codestral" } },
} as unknown as JobExecutor.Input

describe("JobExecutorSession.run", () => {
  effect.effect("charges a failed attempt what its session spent", () =>
    Effect.gen(function* () {
      const executor = yield* JobExecutor.Service
      const outcome = yield* executor.run(input)

      expect(outcome.exitReason).toBe("rate_limited")
      // Reporting zero here is what lets a retried worker run a job with a cost
      // budget over and over without the budget ever seeing the money.
      expect(outcome.usage.cost).toBe(3.1)
      expect(outcome.usage.tokensInput).toBe(240_000)
      expect(outcome.usage.tokensCached).toBe(5_000)
      // The transcript is the only record of what the attempt did before it
      // failed, and a fallback that failed is still a fallback.
      expect(outcome.sessionID).toBe(info.id)
      expect(outcome.resolved).toEqual({ providerID: "mistral", modelID: "codestral-2508" })
    }).pipe(Effect.provide(LayerNode.compile(JobExecutorSession.node, [[SessionV2.node, sessions("429 rate limit")]]))),
  )

  effect.effect("reports what a successful attempt spent", () =>
    Effect.gen(function* () {
      const executor = yield* JobExecutor.Service
      const outcome = yield* executor.run(input)

      expect(outcome.exitReason).toBe("success")
      expect(outcome.usage.cost).toBe(3.1)
    }).pipe(Effect.provide(LayerNode.compile(JobExecutorSession.node, [[SessionV2.node, sessions()]]))),
  )

  effect.effect("runs a worker that owns a worktree inside it", () =>
    Effect.gen(function* () {
      const executor = yield* JobExecutor.Service
      yield* executor.run({
        ...input,
        worker: { ...input.worker, worktree: { directory: "/trees/wrk_one" } },
      } as unknown as JobExecutor.Input)

      // Provisioning a tree and then working somewhere else is worse than not
      // provisioning one: the ledger records an isolation that never happened,
      // and two writing workers edit the same files believing otherwise.
      expect(created[0]?.location?.directory).toBe("/trees/wrk_one")
    }).pipe(Effect.provide(LayerNode.compile(JobExecutorSession.node, [[SessionV2.node, recording()]]))),
  )

  effect.effect("leaves a worker with no worktree in the job's checkout", () =>
    Effect.gen(function* () {
      const executor = yield* JobExecutor.Service
      yield* executor.run(input)
      // A reader has nothing to isolate, and a checkout per reader is a checkout
      // wasted.
      expect(created[0]?.location?.directory).toBe("/project")
    }).pipe(Effect.provide(LayerNode.compile(JobExecutorSession.node, [[SessionV2.node, recording()]]))),
  )
})
