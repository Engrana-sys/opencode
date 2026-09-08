export * as JobStore from "./store"

import { and, asc, desc, eq, gt, inArray } from "drizzle-orm"
import { Context, DateTime, Effect, Layer } from "effect"
import { Job } from "@opencode-ai/schema/job"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { ProjectV2 } from "../project"
import { JobArtifactTable, JobAttemptTable, JobStepTable, JobTable, JobWorkerTable } from "./sql"

/**
 * Reads the job projections.
 *
 * Everything here is derived state. `timeline` is the exception that proves it:
 * it reads the ledger directly rather than a projection, because the ordered
 * history of what happened is the one thing no read model can improve on.
 *
 * @module
 */

const usage = (row: {
  tokens_input: number
  tokens_output: number
  tokens_cached: number
  cost: number
}): Job.Usage => ({
  tokensInput: row.tokens_input,
  tokensOutput: row.tokens_output,
  tokensCached: row.tokens_cached,
  cost: row.cost,
})

const jobFromRow = (row: typeof JobTable.$inferSelect): Job.Info => ({
  id: row.id,
  projectID: row.project_id,
  title: row.title,
  objective: row.objective,
  type: row.type,
  status: row.status,
  ...(row.stage === null ? {} : { stage: row.stage }),
  requestedBy: row.requested_by,
  directory: row.directory,
  ...(row.base_ref === null ? {} : { baseRef: row.base_ref }),
  ...(row.budget === null ? {} : { budget: row.budget }),
  usage: usage(row),
  ...(row.result === null ? {} : { result: row.result }),
  ...(row.error === null ? {} : { error: row.error }),
  ...(row.session_id === null ? {} : { sessionID: row.session_id }),
  timeCreated: DateTime.makeUnsafe(row.time_created),
  ...(row.time_started === null ? {} : { timeStarted: DateTime.makeUnsafe(row.time_started) }),
  ...(row.time_completed === null ? {} : { timeCompleted: DateTime.makeUnsafe(row.time_completed) }),
})

const stepFromRow = (row: typeof JobStepTable.$inferSelect): Job.Step => ({
  id: row.id,
  jobID: row.job_id,
  name: row.name,
  position: row.position,
  status: row.status,
  timeCreated: DateTime.makeUnsafe(row.time_created),
  ...(row.time_completed === null ? {} : { timeCompleted: DateTime.makeUnsafe(row.time_completed) }),
})

const workerFromRow = (row: typeof JobWorkerTable.$inferSelect): Job.Worker => ({
  id: row.id,
  jobID: row.job_id,
  ...(row.step_id === null ? {} : { stepID: row.step_id }),
  ...(row.parent_id === null ? {} : { parentID: row.parent_id }),
  depth: row.depth,
  role: row.role,
  agent: row.agent,
  requested: {
    providerID: row.requested_provider,
    modelID: row.requested_model,
    ...(row.requested_variant === null ? {} : { variant: row.requested_variant }),
  },
  status: row.status,
  ...(row.worktree === null ? {} : { worktree: row.worktree }),
  ...(row.heartbeat_at === null ? {} : { heartbeatAt: DateTime.makeUnsafe(row.heartbeat_at) }),
  ...(row.lease_until === null ? {} : { leaseUntil: DateTime.makeUnsafe(row.lease_until) }),
  ...(row.retry_after === null ? {} : { retryAfter: DateTime.makeUnsafe(row.retry_after) }),
  usage: usage(row),
  timeCreated: DateTime.makeUnsafe(row.time_created),
  ...(row.time_completed === null ? {} : { timeCompleted: DateTime.makeUnsafe(row.time_completed) }),
})

const attemptFromRow = (row: typeof JobAttemptTable.$inferSelect): Job.Attempt => ({
  id: row.id,
  jobID: row.job_id,
  workerID: row.worker_id,
  number: row.number,
  status: row.status,
  requested: {
    providerID: row.requested_provider,
    modelID: row.requested_model,
    ...(row.requested_variant === null ? {} : { variant: row.requested_variant }),
  },
  ...(row.resolved_provider === null || row.resolved_model === null
    ? {}
    : {
        resolved: {
          providerID: row.resolved_provider,
          modelID: row.resolved_model,
          ...(row.resolved_variant === null ? {} : { variant: row.resolved_variant }),
        },
      }),
  ...(row.session_id === null ? {} : { sessionID: row.session_id }),
  usage: usage(row),
  ...(row.exit_reason === null ? {} : { exitReason: row.exit_reason }),
  ...(row.error === null ? {} : { error: row.error }),
  ...(row.retry_reason === null ? {} : { retryReason: row.retry_reason }),
  timeStarted: DateTime.makeUnsafe(row.time_created),
  ...(row.time_completed === null ? {} : { timeCompleted: DateTime.makeUnsafe(row.time_completed) }),
})

const artifactFromRow = (row: typeof JobArtifactTable.$inferSelect): Job.Artifact => ({
  id: row.id,
  jobID: row.job_id,
  ...(row.worker_id === null ? {} : { workerID: row.worker_id }),
  ...(row.step_id === null ? {} : { stepID: row.step_id }),
  type: row.type,
  name: row.name,
  ...(row.content === null ? {} : { content: row.content }),
  ...(row.path === null ? {} : { path: row.path }),
  ...(row.mime === null ? {} : { mime: row.mime }),
  ...(row.bytes === null ? {} : { bytes: row.bytes }),
  timeCreated: DateTime.makeUnsafe(row.time_created),
})

export interface Interface {
  readonly get: (jobID: Job.ID) => Effect.Effect<Job.Info | undefined>
  readonly list: (input?: {
    readonly projectID?: ProjectV2.ID
    readonly status?: ReadonlyArray<Job.Status>
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<Job.Info>>
  /** Jobs that are neither settled nor stale, for recovery and scheduling. */
  readonly live: () => Effect.Effect<ReadonlyArray<Job.Info>>
  readonly steps: (jobID: Job.ID) => Effect.Effect<ReadonlyArray<Job.Step>>
  readonly workers: (jobID: Job.ID) => Effect.Effect<ReadonlyArray<Job.Worker>>
  readonly worker: (workerID: Job.WorkerID) => Effect.Effect<Job.Worker | undefined>
  /** Attempts of one worker, oldest first, so the retry history reads in order. */
  readonly attempts: (workerID: Job.WorkerID) => Effect.Effect<ReadonlyArray<Job.Attempt>>
  readonly artifacts: (jobID: Job.ID) => Effect.Effect<ReadonlyArray<Job.Artifact>>
  /** The job's own ledger entries, in the order they were appended. */
  readonly timeline: (jobID: Job.ID, after?: number) => Effect.Effect<ReadonlyArray<EventV2.Payload>>
  /** Live workers whose lease has lapsed. Recovery treats these as abandoned. */
  readonly expired: (now?: DateTime.Utc) => Effect.Effect<ReadonlyArray<Job.Worker>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/JobStore") {}

const LIVE: ReadonlyArray<Job.Status> = [
  "created",
  "planning",
  "queued",
  "running",
  "blocked",
  "waiting_human",
  "verifying",
  "reviewing",
]

/**
 * Only a running worker must hold a lease.
 *
 * A queued worker is waiting for a slot and a `waiting_input` one is waiting for
 * a person; neither is executing anything a dying process could abandon, and
 * neither should be reclaimed for going quiet. Including them would let recovery
 * kill work that was never started, and would put a two-minute lease on a human
 * who might answer tomorrow.
 */
const LIVE_WORKERS: ReadonlyArray<Job.WorkerStatus> = ["running"]

const DEFAULT_LIMIT = 50

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return Service.of({
      get: Effect.fn("JobStore.get")(function* (jobID) {
        const row = yield* db.select().from(JobTable).where(eq(JobTable.id, jobID)).get().pipe(Effect.orDie)
        return row ? jobFromRow(row) : undefined
      }),

      list: Effect.fn("JobStore.list")(function* (input) {
        const filters = [
          ...(input?.projectID === undefined ? [] : [eq(JobTable.project_id, input.projectID)]),
          ...(input?.status === undefined || input.status.length === 0
            ? []
            : [inArray(JobTable.status, [...input.status])]),
        ]
        const rows = yield* db
          .select()
          .from(JobTable)
          .where(filters.length === 0 ? undefined : and(...filters))
          .orderBy(desc(JobTable.time_created))
          .limit(input?.limit ?? DEFAULT_LIMIT)
          .all()
          .pipe(Effect.orDie)
        return rows.map(jobFromRow)
      }),

      live: Effect.fn("JobStore.live")(function* () {
        const rows = yield* db
          .select()
          .from(JobTable)
          .where(inArray(JobTable.status, [...LIVE]))
          .orderBy(asc(JobTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(jobFromRow)
      }),

      steps: Effect.fn("JobStore.steps")(function* (jobID) {
        const rows = yield* db
          .select()
          .from(JobStepTable)
          .where(eq(JobStepTable.job_id, jobID))
          .orderBy(asc(JobStepTable.position))
          .all()
          .pipe(Effect.orDie)
        return rows.map(stepFromRow)
      }),

      workers: Effect.fn("JobStore.workers")(function* (jobID) {
        const rows = yield* db
          .select()
          .from(JobWorkerTable)
          .where(eq(JobWorkerTable.job_id, jobID))
          .orderBy(asc(JobWorkerTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(workerFromRow)
      }),

      worker: Effect.fn("JobStore.worker")(function* (workerID) {
        const row = yield* db
          .select()
          .from(JobWorkerTable)
          .where(eq(JobWorkerTable.id, workerID))
          .get()
          .pipe(Effect.orDie)
        return row ? workerFromRow(row) : undefined
      }),

      attempts: Effect.fn("JobStore.attempts")(function* (workerID) {
        const rows = yield* db
          .select()
          .from(JobAttemptTable)
          .where(eq(JobAttemptTable.worker_id, workerID))
          .orderBy(asc(JobAttemptTable.number))
          .all()
          .pipe(Effect.orDie)
        return rows.map(attemptFromRow)
      }),

      artifacts: Effect.fn("JobStore.artifacts")(function* (jobID) {
        const rows = yield* db
          .select()
          .from(JobArtifactTable)
          .where(eq(JobArtifactTable.job_id, jobID))
          .orderBy(asc(JobArtifactTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(artifactFromRow)
      }),

      timeline: Effect.fn("JobStore.timeline")(function* (jobID, after) {
        // A timeline is a finished history, so it reads the ledger rows rather
        // than `events.durable`, whose stream stays open for events still to come.
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(
            after === undefined
              ? eq(EventTable.aggregate_id, jobID)
              : and(eq(EventTable.aggregate_id, jobID), gt(EventTable.seq, after)),
          )
          .orderBy(asc(EventTable.seq))
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) =>
          EventV2.decodeSerializedEvent({
            id: row.id,
            type: row.type,
            seq: row.seq,
            aggregateID: row.aggregate_id,
            data: row.data,
          }),
        )
      }),

      expired: Effect.fn("JobStore.expired")(function* (now) {
        const cutoff = DateTime.toEpochMillis(now ?? (yield* DateTime.now))
        const rows = yield* db
          .select()
          .from(JobWorkerTable)
          .where(inArray(JobWorkerTable.status, [...LIVE_WORKERS]))
          .all()
          .pipe(Effect.orDie)
        // A live worker with no lease at all has never started one; treat it as
        // expired too, so nothing claiming to run escapes the recovery scan.
        return rows.filter((row) => row.lease_until === null || row.lease_until <= cutoff).map(workerFromRow)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
