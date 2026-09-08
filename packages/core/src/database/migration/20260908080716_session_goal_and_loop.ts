import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908080716_session_goal_and_loop",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_goal\` (
          \`session_id\` text PRIMARY KEY,
          \`condition\` text NOT NULL,
          \`status\` text NOT NULL,
          \`iterations\` integer NOT NULL,
          \`budget\` integer NOT NULL,
          \`verdict\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_goal_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_loop\` (
          \`session_id\` text PRIMARY KEY,
          \`prompt\` text NOT NULL,
          \`interval\` integer,
          \`iterations\` integer NOT NULL,
          \`budget\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`next_run\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_loop_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
