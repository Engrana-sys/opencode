export * as JobProjector from "./projector"

import { eq, sql } from "drizzle-orm"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { DateTime, Effect, Layer } from "effect"
import { Job } from "@opencode-ai/schema/job"
import { JobEvent } from "@opencode-ai/schema/job-event"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { ProjectV2 } from "../project"
import {
  JobArtifactTable,
  JobAttemptTable,
  JobStepTable,
  JobTable,
  JobVerificationTable,
  JobWorkerTable,
} from "./sql"

/**
 * Builds the job read models from the ledger.
 *
 * Handlers here are the only writers to the job tables, and each one is driven
 * by exactly one event type. They must stay replayable: a handler may be run
 * again over the same event when a projection is rebuilt, so every write is
 * either idempotent or keyed by an identifier the event itself carries.
 *
 * @module
 */

const millis = (value: DateTime.Utc) => DateTime.toEpochMillis(value)

/**
 * Usage is recomputed from children, never accumulated.
 *
 * A worker's cost is the sum of its attempts and a job's is the sum of its
 * workers, so both are derivable and neither needs a running total. Adding on
 * settlement was cheaper and wrong twice over: replaying the ledger counted
 * every attempt again, which is the one thing a projection handler may not do,
 * and an attempt settled a second time — a late recovery landing on work that
 * had already finished — added its usage on top of the amount it was meant to
 * replace.
 *
 * A sum over a handful of attempts costs nothing next to the provider call that
 * produced them.
 */
const sumFromAttempts = (workerID: Job.WorkerID) => {
  const total = (column: AnySQLiteColumn) =>
    sql`(select coalesce(sum(${column}), 0) from ${JobAttemptTable} where ${JobAttemptTable.worker_id} = ${workerID})`
  return {
    tokens_input: total(JobAttemptTable.tokens_input),
    tokens_output: total(JobAttemptTable.tokens_output),
    tokens_cached: total(JobAttemptTable.tokens_cached),
    cost: total(JobAttemptTable.cost),
  }
}

const sumFromWorkers = (jobID: Job.ID) => {
  const total = (column: AnySQLiteColumn) =>
    sql`(select coalesce(sum(${column}), 0) from ${JobWorkerTable} where ${JobWorkerTable.job_id} = ${jobID})`
  return {
    tokens_input: total(JobWorkerTable.tokens_input),
    tokens_output: total(JobWorkerTable.tokens_output),
    tokens_cached: total(JobWorkerTable.tokens_cached),
    cost: total(JobWorkerTable.cost),
  }
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    yield* events.project(JobEvent.Created, (event) =>
      db
        .insert(JobTable)
        .values({
          id: event.data.jobID,
          project_id: ProjectV2.ID.make(event.data.projectID),
          directory: event.data.directory,
          title: event.data.title,
          objective: event.data.objective,
          type: event.data.jobType,
          status: "created",
          requested_by: event.data.requestedBy,
          base_ref: event.data.baseRef ?? null,
          budget: event.data.budget ?? null,
          session_id: event.data.sessionID ?? null,
          time_created: millis(event.data.timestamp),
          time_updated: millis(event.data.timestamp),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(JobEvent.StatusChanged, (event) =>
      db
        .update(JobTable)
        .set({
          status: event.data.to,
          stage: event.data.stage ?? null,
          // The *first* entry into a working state is when the job started, and
          // COALESCE is what makes that true: `running` is re-enterable from
          // five states, and rewriting this on each pass would hand a job that
          // bounces through `blocked` a fresh wall-clock budget every time.
          // It also keeps the handler idempotent under replay.
          ...(event.data.to === "running"
            ? { time_started: sql`coalesce(${JobTable.time_started}, ${millis(event.data.timestamp)})` }
            : {}),
          time_updated: millis(event.data.timestamp),
        })
        .where(eq(JobTable.id, event.data.jobID))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(JobEvent.Settled, (event) =>
      db
        .update(JobTable)
        .set({
          status: event.data.status,
          stage: null,
          result: event.data.result ?? null,
          error: event.data.error ?? null,
          time_completed: millis(event.data.timestamp),
          time_updated: millis(event.data.timestamp),
        })
        .where(eq(JobTable.id, event.data.jobID))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(JobEvent.StepAdded, (event) =>
      db
        .insert(JobStepTable)
        .values({
          id: event.data.stepID,
          job_id: event.data.jobID,
          name: event.data.name,
          position: event.data.position,
          status: "created",
          time_created: millis(event.data.timestamp),
          time_updated: millis(event.data.timestamp),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(JobEvent.StepSettled, (event) =>
      db
        .update(JobStepTable)
        .set({
          status: event.data.status,
          ...(Job.isTerminal(event.data.status) ? { time_completed: millis(event.data.timestamp) } : {}),
          time_updated: millis(event.data.timestamp),
        })
        .where(eq(JobStepTable.id, event.data.stepID))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(JobEvent.WorkerCreated, (event) =>
      db
        .insert(JobWorkerTable)
        .values({
          id: event.data.workerID,
          job_id: event.data.jobID,
          step_id: event.data.stepID ?? null,
          parent_id: event.data.parentID ?? null,
          depth: event.data.depth,
          role: event.data.role,
          agent: event.data.agent,
          requested_provider: event.data.requested.providerID,
          requested_model: event.data.requested.modelID,
          requested_variant: event.data.requested.variant ?? null,
          permissions: event.data.permissions,
          status: "created",
          worktree: event.data.worktree ?? null,
          time_created: millis(event.data.timestamp),
          time_updated: millis(event.data.timestamp),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(JobEvent.WorkerStatusChanged, (event) =>
      db
        .update(JobWorkerTable)
        .set({
          status: event.data.to,
          ...(event.data.to === "completed" ||
          event.data.to === "failed" ||
          event.data.to === "cancelled" ||
          event.data.to === "stale"
            ? // A settled worker holds no lease; leaving one would make recovery
              // rediscover work that is already finished.
              { time_completed: millis(event.data.timestamp), lease_until: null }
            : {}),
          // A worker leaving `running` releases its lease even when it is going
          // back to the queue, and carries its backoff with it.
          ...(event.data.to === "queued"
            ? {
                lease_until: null,
                retry_after: event.data.retryAfter === undefined ? null : millis(event.data.retryAfter),
              }
            : {}),
          // The lease is granted by the transition itself, not by the first
          // heartbeat. Those are two separate durable writes, and in the gap
          // between them the row reads `running` with no lease — which is
          // exactly what `JobStore.expired` treats as abandoned. Recovery would
          // then declare stale a worker whose executor had just started.
          ...(event.data.to === "running"
            ? { lease_until: millis(event.data.timestamp) + Job.LEASE_MS, retry_after: null }
            : {}),
          time_updated: millis(event.data.timestamp),
        })
        .where(eq(JobWorkerTable.id, event.data.workerID))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(JobEvent.WorkerWorktreeAssigned, (event) =>
      db
        .update(JobWorkerTable)
        .set({ worktree: event.data.worktree, time_updated: millis(event.data.timestamp) })
        .where(eq(JobWorkerTable.id, event.data.workerID))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(JobEvent.WorkerHeartbeat, (event) =>
      db
        .update(JobWorkerTable)
        .set({
          heartbeat_at: millis(event.data.timestamp),
          lease_until: millis(event.data.leaseUntil),
          time_updated: millis(event.data.timestamp),
        })
        .where(eq(JobWorkerTable.id, event.data.workerID))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(JobEvent.AttemptStarted, (event) =>
      db
        .insert(JobAttemptTable)
        .values({
          id: event.data.attemptID,
          job_id: event.data.jobID,
          worker_id: event.data.workerID,
          number: event.data.number,
          status: "running",
          requested_provider: event.data.requested.providerID,
          requested_model: event.data.requested.modelID,
          requested_variant: event.data.requested.variant ?? null,
          session_id: event.data.sessionID ?? null,
          retry_reason: event.data.retryReason ?? null,
          time_created: millis(event.data.timestamp),
          time_updated: millis(event.data.timestamp),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(JobEvent.ModelResolved, (event) =>
      db
        .update(JobAttemptTable)
        .set({
          resolved_provider: event.data.resolved.providerID,
          resolved_model: event.data.resolved.modelID,
          resolved_variant: event.data.resolved.variant ?? null,
          time_updated: millis(event.data.timestamp),
        })
        .where(eq(JobAttemptTable.id, event.data.attemptID))
        .run()
        .pipe(Effect.orDie),
    )

    yield* events.project(JobEvent.AttemptSettled, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(JobAttemptTable)
          .set({
            status: event.data.status,
            exit_reason: event.data.exitReason,
            error: event.data.error ?? null,
            tokens_input: event.data.usage.tokensInput,
            tokens_output: event.data.usage.tokensOutput,
            tokens_cached: event.data.usage.tokensCached,
            cost: event.data.usage.cost,
            time_completed: millis(event.data.timestamp),
            time_updated: millis(event.data.timestamp),
          })
          .where(eq(JobAttemptTable.id, event.data.attemptID))
          .run()
          .pipe(Effect.orDie)
        // Ordered: the attempt row above is what the worker's sum reads, and the
        // worker's total is what the job's sum reads.
        yield* db
          .update(JobWorkerTable)
          .set(sumFromAttempts(event.data.workerID))
          .where(eq(JobWorkerTable.id, event.data.workerID))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(JobTable)
          .set(sumFromWorkers(event.data.jobID))
          .where(eq(JobTable.id, event.data.jobID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    yield* events.project(JobEvent.ArtifactAdded, (event) =>
      db
        .insert(JobArtifactTable)
        .values({
          id: event.data.artifactID,
          job_id: event.data.jobID,
          worker_id: event.data.workerID ?? null,
          step_id: event.data.stepID ?? null,
          type: event.data.artifactType,
          name: event.data.name,
          content: event.data.content ?? null,
          path: event.data.path ?? null,
          mime: event.data.mime ?? null,
          bytes: event.data.bytes ?? null,
          time_created: millis(event.data.timestamp),
          time_updated: millis(event.data.timestamp),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie),
    )

    // Keyed by the event's own id, the one identifier a verdict carries that is
    // stable across a replay. Without a projection at all, a recorded verdict
    // was readable only by decoding raw ledger rows — a hole in "state lives in
    // projections" exactly where the verifier's output lands.
    yield* events.project(JobEvent.Verified, (event) =>
      db
        .insert(JobVerificationTable)
        .values({
          id: event.id,
          job_id: event.data.jobID,
          worker_id: event.data.workerID ?? null,
          step_id: event.data.stepID ?? null,
          verdict: event.data.verdict,
          results: event.data.results,
          time_created: millis(event.data.timestamp),
          time_updated: millis(event.data.timestamp),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie),
    )
  }),
)

export const node = makeGlobalNode({ name: "job-projector", layer, deps: [EventV2.node, Database.node] })
