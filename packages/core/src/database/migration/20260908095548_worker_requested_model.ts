import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908095548_worker_requested_model",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`job_worker\` ADD \`requested_provider\` text NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`job_worker\` ADD \`requested_model\` text NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`job_worker\` ADD \`requested_variant\` text;`)
      yield* tx.run(`CREATE INDEX \`job_worker_queue_idx\` ON \`job_worker\` (\`status\`,\`requested_provider\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
