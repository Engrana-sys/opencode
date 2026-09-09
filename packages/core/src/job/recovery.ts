export * as JobRecovery from "./recovery"

import { Context, DateTime, Effect, Layer } from "effect"
import type { Job } from "@opencode-ai/schema/job"
import { makeGlobalNode } from "../effect/app-node"
import { JobV2 } from "../job"
import { JobRetry } from "./retry"
import { JobStore } from "./store"
import { JobWorktree } from "./worktree"

/**
 * Reclaims work abandoned by a process that died.
 *
 * A crash leaves rows saying `running` with nothing running. The status column
 * cannot be trusted for this, because the process that would have corrected it
 * is the one that died; the lease can, because it expires on its own. So this
 * scan reads leases, not statuses.
 *
 * Reclassification is deliberately conservative. The abandoned attempt is
 * settled, and only then does the retry policy decide whether the work runs
 * again: safe work goes back to the queue with its backoff and the rest is left
 * `stale` for a person. Nothing is restarted here: a scan that silently
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
        const now = DateTime.toEpochMillis(yield* DateTime.now)
        for (const expired of yield* store.expired()) {
          // The snapshot above is one read that releases the database between
          // statements, and every write below yields again. A heartbeat landing
          // in that gap renews the lease of a worker that is very much alive, so
          // the row is read once more immediately before it is written off:
          // recovery trusts the lease, and the lease may have moved since.
          const worker = yield* store.worker(expired.id)
          if (worker === undefined || worker.status !== "running") continue
          if (worker.leaseUntil !== undefined && DateTime.toEpochMillis(worker.leaseUntil) > now) continue

          const attempts = yield* store.attempts(worker.id)
          const running = attempts.find((attempt) => attempt.status === "running")
          const last = attempts.at(-1)
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
          // Settling an attempt and moving its worker are two durable writes. A
          // process killed between them left work that actually succeeded, so
          // the move it never made is finished here rather than the success
          // being reported as an abandoned worker that has to run again.
          else if (last?.status === "completed") {
            yield* jobs
              .workerStatus({
                workerID: worker.id,
                to: "completed",
                reason: "Attempt completed before the process stopped reporting",
              })
              .pipe(Effect.ignore)
            continue
          }

          // What decides this is whether the dead worker could have left changes
          // behind, not why it stopped. A worker that only reads has nothing to
          // undo, so running it again is free. One that writes may hold a
          // half-applied diff, and re-running over that compounds the mess: a
          // person has to look at the tree first. A missing worktree does not
          // make a worker a reader — provisioning returns none for a project
          // that is not a git repository, and that worker wrote into the
          // project checkout itself.
          const writes = worker.worktree !== undefined || JobWorktree.writes(worker.role)
          const what = running
            ? "Attempt stalled"
            : last === undefined
              ? "Lease expired before any attempt started"
              : `Lease expired after attempt ${last.number} ended ${last.status}`
          const outcome: Outcome = {
            workerID: worker.id,
            jobID: worker.jobID,
            ...(writes
              ? {
                  disposition: "needs_review" as const,
                  reason:
                    worker.worktree === undefined
                      ? `${what}; the ${worker.role} worker writes and had no worktree of its own`
                      : `${what}; the worker holds worktree ${worker.worktree.directory}`,
                }
              : { disposition: "retryable" as const, reason: `${what}; the worker wrote nothing` }),
          }
          // The verdict has to move the worker, because nothing else will: the
          // scheduler only requeues workers whose live executor came back, and a
          // `stale` worker is terminal, so one left there strands its job with
          // no worker able to run and no way to reach an end state. Safe work
          // goes back to the queue carrying its backoff — the same move the
          // scheduler makes for an attempt that failed in front of it.
          const decision = JobRetry.decide({
            exitReason: running || last === undefined ? "stalled" : last.exitReason ?? "stalled",
            attempts: attempts.length,
          })
          const retry =
            outcome.disposition === "retryable" && decision._tag === "Retry" ? decision : undefined
          yield* jobs
            .workerStatus({
              workerID: worker.id,
              to: retry ? "queued" : "stale",
              reason: outcome.reason,
              ...(retry ? { retryAfterMs: retry.delay } : {}),
            })
            .pipe(Effect.ignore)
          outcomes.push(outcome)
        }
        return outcomes
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [JobStore.node, JobV2.node] })
