import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908100044_worker_retry_after",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`job_worker\` ADD \`retry_after\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
