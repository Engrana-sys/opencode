import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911193317_job_verification",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`job_verification\` (
          \`id\` text PRIMARY KEY,
          \`job_id\` text NOT NULL,
          \`worker_id\` text,
          \`step_id\` text,
          \`verdict\` text NOT NULL,
          \`results\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_job_verification_job_id_job_id_fk\` FOREIGN KEY (\`job_id\`) REFERENCES \`job\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`job_verification_job_idx\` ON \`job_verification\` (\`job_id\`);`)
      yield* tx.run(`CREATE INDEX \`job_verification_worker_idx\` ON \`job_verification\` (\`worker_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
