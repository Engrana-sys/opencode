export * as ConfigGoal from "./goal"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.Goal")({
  budget: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum continuations one goal may spend before it stops on its own",
  }),
}) {}
