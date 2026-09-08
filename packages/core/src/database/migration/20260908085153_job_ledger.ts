import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908085153_job_ledger",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`job_artifact\` (
          \`id\` text PRIMARY KEY,
          \`job_id\` text NOT NULL,
          \`worker_id\` text,
          \`step_id\` text,
          \`type\` text NOT NULL,
          \`name\` text NOT NULL,
          \`content\` text,
          \`path\` text,
          \`mime\` text,
          \`bytes\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_job_artifact_job_id_job_id_fk\` FOREIGN KEY (\`job_id\`) REFERENCES \`job\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`job_worker_attempt\` (
          \`id\` text PRIMARY KEY,
          \`job_id\` text NOT NULL,
          \`worker_id\` text NOT NULL,
          \`number\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`requested_provider\` text NOT NULL,
          \`requested_model\` text NOT NULL,
          \`requested_variant\` text,
          \`resolved_provider\` text,
          \`resolved_model\` text,
          \`resolved_variant\` text,
          \`session_id\` text,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_cached\` integer DEFAULT 0 NOT NULL,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`exit_reason\` text,
          \`error\` text,
          \`retry_reason\` text,
          \`time_completed\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_job_worker_attempt_job_id_job_id_fk\` FOREIGN KEY (\`job_id\`) REFERENCES \`job\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_job_worker_attempt_worker_id_job_worker_id_fk\` FOREIGN KEY (\`worker_id\`) REFERENCES \`job_worker\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`job_step\` (
          \`id\` text PRIMARY KEY,
          \`job_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`time_completed\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_job_step_job_id_job_id_fk\` FOREIGN KEY (\`job_id\`) REFERENCES \`job\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`job\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`title\` text NOT NULL,
          \`objective\` text NOT NULL,
          \`type\` text NOT NULL,
          \`status\` text NOT NULL,
          \`stage\` text,
          \`requested_by\` text NOT NULL,
          \`base_ref\` text,
          \`budget\` text,
          \`session_id\` text,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_cached\` integer DEFAULT 0 NOT NULL,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`result\` text,
          \`error\` text,
          \`time_started\` integer,
          \`time_completed\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_job_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`job_worker\` (
          \`id\` text PRIMARY KEY,
          \`job_id\` text NOT NULL,
          \`step_id\` text,
          \`parent_id\` text,
          \`depth\` integer NOT NULL,
          \`role\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`status\` text NOT NULL,
          \`worktree\` text,
          \`heartbeat_at\` integer,
          \`lease_until\` integer,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_cached\` integer DEFAULT 0 NOT NULL,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`time_completed\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_job_worker_job_id_job_id_fk\` FOREIGN KEY (\`job_id\`) REFERENCES \`job\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`job_artifact_job_idx\` ON \`job_artifact\` (\`job_id\`);`)
      yield* tx.run(`CREATE INDEX \`job_artifact_worker_idx\` ON \`job_artifact\` (\`worker_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`job_attempt_worker_number_idx\` ON \`job_worker_attempt\` (\`worker_id\`,\`number\`);`,
      )
      yield* tx.run(`CREATE INDEX \`job_attempt_job_idx\` ON \`job_worker_attempt\` (\`job_id\`);`)
      yield* tx.run(`CREATE INDEX \`job_step_job_position_idx\` ON \`job_step\` (\`job_id\`,\`position\`);`)
      yield* tx.run(`CREATE INDEX \`job_project_status_idx\` ON \`job\` (\`project_id\`,\`status\`);`)
      yield* tx.run(`CREATE INDEX \`job_status_idx\` ON \`job\` (\`status\`);`)
      yield* tx.run(`CREATE INDEX \`job_worker_job_idx\` ON \`job_worker\` (\`job_id\`);`)
      yield* tx.run(`CREATE INDEX \`job_worker_parent_idx\` ON \`job_worker\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`job_worker_lease_idx\` ON \`job_worker\` (\`status\`,\`lease_until\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
