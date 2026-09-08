import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908101054_worker_permissions",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`job_worker\` ADD \`permissions\` text NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
