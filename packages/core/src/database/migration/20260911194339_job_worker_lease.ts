import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911194339_job_worker_lease",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`job_worker_lease\` (
          \`worker_id\` text PRIMARY KEY,
          \`heartbeat_at\` integer NOT NULL,
          \`lease_until\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`DROP INDEX IF EXISTS \`job_worker_lease_idx\`;`)
      yield* tx.run(`ALTER TABLE \`job_worker\` DROP COLUMN \`heartbeat_at\`;`)
      yield* tx.run(`ALTER TABLE \`job_worker\` DROP COLUMN \`lease_until\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
