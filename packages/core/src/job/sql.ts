import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import { ProjectTable } from "../project/sql"
import { ProjectV2 } from "../project"
import type { Job } from "@opencode-ai/schema/job"
import type { JobVerification } from "@opencode-ai/schema/job-verification"
import type { Permission } from "@opencode-ai/schema/permission"
import type { SessionSchema } from "../session/schema"
import * as DatabasePath from "../database/path"

/**
 * Read models for the job ledger.
 *
 * Every column here is derived: the `event` table under a `job` aggregate is
 * authoritative, and these tables exist so a listing does not have to replay
 * one. They may be dropped and rebuilt. Nothing writes to them except the
 * projector.
 */

export const JobTable = sqliteTable(
  "job",
  {
    id: text().$type<Job.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    directory: DatabasePath.directoryColumn().notNull(),
    title: text().notNull(),
    objective: text().notNull(),
    type: text().notNull(),
    status: text().$type<Job.Status>().notNull(),
    stage: text(),
    requested_by: text().notNull(),
    base_ref: text(),
    budget: text({ mode: "json" }).$type<Job.Budget>(),
    session_id: text().$type<SessionSchema.ID>(),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_cached: integer().notNull().default(0),
    cost: real().notNull().default(0),
    result: text(),
    error: text(),
    time_started: integer(),
    time_completed: integer(),
    ...Timestamps,
  },
  (table) => [
    index("job_project_status_idx").on(table.project_id, table.status),
    index("job_status_idx").on(table.status),
  ],
)

export const JobStepTable = sqliteTable(
  "job_step",
  {
    id: text().$type<Job.StepID>().primaryKey(),
    job_id: text()
      .$type<Job.ID>()
      .notNull()
      .references(() => JobTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    position: integer().notNull(),
    status: text().$type<Job.Status>().notNull(),
    time_completed: integer(),
    ...Timestamps,
  },
  (table) => [index("job_step_job_position_idx").on(table.job_id, table.position)],
)

export const JobWorkerTable = sqliteTable(
  "job_worker",
  {
    id: text().$type<Job.WorkerID>().primaryKey(),
    job_id: text()
      .$type<Job.ID>()
      .notNull()
      .references(() => JobTable.id, { onDelete: "cascade" }),
    step_id: text().$type<Job.StepID>(),
    parent_id: text().$type<Job.WorkerID>(),
    depth: integer().notNull(),
    role: text().notNull(),
    agent: text().notNull(),
    requested_provider: text().notNull(),
    requested_model: text().notNull(),
    requested_variant: text(),
    permissions: text({ mode: "json" }).$type<Permission.Ruleset>().notNull(),
    status: text().$type<Job.WorkerStatus>().notNull(),
    worktree: text({ mode: "json" }).$type<Job.Worktree>(),
    heartbeat_at: integer(),
    lease_until: integer(),
    retry_after: integer(),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_cached: integer().notNull().default(0),
    cost: real().notNull().default(0),
    time_completed: integer(),
    ...Timestamps,
  },
  (table) => [
    index("job_worker_job_idx").on(table.job_id),
    index("job_worker_parent_idx").on(table.parent_id),
    // Recovery scans live workers by lease expiry; keep that a range scan.
    index("job_worker_lease_idx").on(table.status, table.lease_until),
    index("job_worker_queue_idx").on(table.status, table.requested_provider),
  ],
)

export const JobAttemptTable = sqliteTable(
  "job_worker_attempt",
  {
    id: text().$type<Job.AttemptID>().primaryKey(),
    job_id: text()
      .$type<Job.ID>()
      .notNull()
      .references(() => JobTable.id, { onDelete: "cascade" }),
    worker_id: text()
      .$type<Job.WorkerID>()
      .notNull()
      .references(() => JobWorkerTable.id, { onDelete: "cascade" }),
    number: integer().notNull(),
    status: text().$type<Job.AttemptStatus>().notNull(),
    // Requested and resolved are stored apart on purpose: a fallback that
    // overwrote the request would be invisible afterwards.
    requested_provider: text().notNull(),
    requested_model: text().notNull(),
    requested_variant: text(),
    resolved_provider: text(),
    resolved_model: text(),
    resolved_variant: text(),
    session_id: text().$type<SessionSchema.ID>(),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_cached: integer().notNull().default(0),
    cost: real().notNull().default(0),
    exit_reason: text().$type<Job.ExitReason>(),
    error: text(),
    retry_reason: text(),
    time_completed: integer(),
    ...Timestamps,
  },
  (table) => [
    index("job_attempt_worker_number_idx").on(table.worker_id, table.number),
    index("job_attempt_job_idx").on(table.job_id),
  ],
)

export const JobArtifactTable = sqliteTable(
  "job_artifact",
  {
    id: text().$type<Job.ArtifactID>().primaryKey(),
    job_id: text()
      .$type<Job.ID>()
      .notNull()
      .references(() => JobTable.id, { onDelete: "cascade" }),
    worker_id: text().$type<Job.WorkerID>(),
    step_id: text().$type<Job.StepID>(),
    type: text().$type<Job.ArtifactType>().notNull(),
    name: text().notNull(),
    content: text(),
    path: text(),
    mime: text(),
    bytes: integer(),
    ...Timestamps,
  },
  (table) => [index("job_artifact_job_idx").on(table.job_id), index("job_artifact_worker_idx").on(table.worker_id)],
)

/**
 * What a verifier decided, and on what evidence.
 *
 * Keyed by the ledger event's own id rather than a generated one, because that
 * is what makes the handler idempotent: replaying the ledger writes the same row
 * back instead of a second copy of the same verdict.
 *
 * `results` is stored whole rather than normalised into a row per check. A
 * verdict is read as a unit — a check that could not run is only meaningful
 * beside the ones that did — and nothing queries individual checks.
 */
export const JobVerificationTable = sqliteTable(
  "job_verification",
  {
    id: text().primaryKey(),
    job_id: text()
      .$type<Job.ID>()
      .notNull()
      .references(() => JobTable.id, { onDelete: "cascade" }),
    worker_id: text().$type<Job.WorkerID>(),
    step_id: text().$type<Job.StepID>(),
    verdict: text().$type<JobVerification.Verdict>().notNull(),
    results: text({ mode: "json" }).$type<ReadonlyArray<JobVerification.Result>>().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("job_verification_job_idx").on(table.job_id),
    index("job_verification_worker_idx").on(table.worker_id),
  ],
)
