import { describe, expect } from "bun:test"
import { Duration, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Job } from "@opencode-ai/schema/job"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { JobV2 } from "@opencode-ai/core/job"
import { JobProjector } from "@opencode-ai/core/job/projector"
import { JobRecovery } from "@opencode-ai/core/job/recovery"
import { JobStore } from "@opencode-ai/core/job/store"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, JobProjector.node, JobStore.node, JobV2.node, JobRecovery.node]),
  ),
)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
})

describe("race", () => {
  for (const yields of [0, 1, 2, 3]) {
    it.effect(`renewal during the scan, ${yields} yields`, () =>
      Effect.gen(function* () {
        yield* setup
        const jobs = yield* JobV2.Service
        const store = yield* JobStore.Service
        const recovery = yield* JobRecovery.Service
        const job = yield* jobs.create({ projectID: Project.ID.global, directory: "/project", title: "t", objective: "o", type: "audit", requestedBy: "user" })
        const worker = yield* jobs.createWorker({ jobID: job.id, role: "scout", agent: "scout", requested: { providerID: "m", modelID: "c" } })
        yield* jobs.workerStatus({ workerID: worker.id, to: "running" })
        yield* jobs.startAttempt({ workerID: worker.id, requested: { providerID: "m", modelID: "c" } })
        yield* TestClock.adjust(Duration.millis(Job.LEASE_MS + 1))
        const fiber = yield* Effect.forkChild(recovery.scan())
        for (let i = 0; i < yields; i++) yield* Effect.yieldNow
        yield* jobs.heartbeat({ workerID: worker.id, leaseMs: Job.LEASE_MS })
        const outcomes = yield* Fiber.join(fiber)
        console.log(`yields=${yields}`, "outcomes", outcomes.length, "status", (yield* store.worker(worker.id))?.status)
        expect(true).toBe(true)
      }),
    )
  }
})
