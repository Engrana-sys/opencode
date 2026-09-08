export * as ConfigLoop from "./loop"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.Loop")({
  budget: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum iterations one loop may run before it stops on its own",
  }),
  interval: PositiveInt.pipe(Schema.optional).annotate({
    description: "Default milliseconds between iterations when a loop is started without one",
  }),
}) {}
