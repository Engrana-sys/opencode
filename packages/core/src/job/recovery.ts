export * as JobRecovery from "./recovery"

import { Context, Effect, Layer } from "effect"
import type { Job } from "@opencode-ai/schema/job"
import { makeGlobalNode } from "../effect/app-node"
import { JobV2 } from "../job"
import { JobStore } from "./store"

/**
 * Reclaims work abandoned by a process that died.
 *
 * A crash leaves rows saying `running` with nothing running. The status column
 * cannot be trusted for this, because the process that would have corrected it
 * is the one that died; the lease can, because it expires on its own. So this
 * scan reads leases, not statuses.
 *
 * Reclassification is deliberately conservative. A worker is marked `stale` and
 * its last attempt settled, and only then does the retry policy decide whether
 * the work runs again. Nothing is restarted here: a scan that silently
 * re-launched work would double-run whatever the dead process had already
 * half-finished, and on a writing worker that means a half-applied diff.
 *
 * @module
 */

export interface Outcome {
  readonly workerID: Job.WorkerID
  readonly jobID: Job.ID
  /** Retryable work may run again; the rest needs someone to look at it. */
  readonly disposition: "retryable" | "needs_review"
  readonly reason: string
}

export interface Interface {
  /** Settles every worker whose lease has lapsed. Safe to run more than once. */
  readonly scan: () => Effect.Effect<ReadonlyArray<Outcome>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/JobRecovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* JobStore.Service
    const jobs = yield* JobV2.Service

    return Service.of({
      scan: Effect.fn("JobRecovery.scan")(function* () {
        const outcomes: Outcome[] = []
        for (const worker of yield* store.expired()) {
          const attempts = yield* store.attempts(worker.id)
          const running = attempts.find((attempt) => attempt.status === "running")
          // An attempt left mid-flight has no outcome of its own; record why it
          // ended rather than leaving it running forever alongside its worker.
          if (running)
            yield* jobs
              .settleAttempt({
                attemptID: running.id,
                workerID: worker.id,
                status: "stale",
                exitReason: "stalled",
                error: "The process holding this attempt stopped reporting.",
              })
              .pipe(Effect.ignore)
          yield* jobs
            .workerStatus({ workerID: worker.id, to: "stale", reason: "Lease expired" })
            .pipe(Effect.ignore)
          // What decides this is whether the dead worker could have left changes
          // behind, not why it stopped. A read-only worker has nothing to undo,
          // so running it again is free. One that owned a worktree may hold a
          // half-applied diff, and re-running over that compounds the mess: a
          // person has to look at the tree first.
          outcomes.push({
            workerID: worker.id,
            jobID: worker.jobID,
            ...(worker.worktree === undefined
              ? {
                  disposition: "retryable" as const,
                  reason:
                    running === undefined
                      ? "Lease expired before any attempt started"
                      : "Attempt stalled; the worker wrote nothing",
                }
              : {
                  disposition: "needs_review" as const,
                  reason: `Attempt stalled holding worktree ${worker.worktree.directory}`,
                }),
          })
        }
        return outcomes
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [JobStore.node, JobV2.node] })
