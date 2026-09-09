import { describe, expect, it } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { JobExecutor } from "@opencode-ai/core/job/executor"
import { JobScheduler } from "@opencode-ai/core/job/scheduler"

describe("JobExecutor.node", () => {
  it("refuses a graph that never installs an executor", () => {
    // The scheduler is given its executor when its own node compiles, so one
    // merged beside it in the group is never the one it calls: every attempt
    // would fail `infrastructure_failure` and retry itself out of attempts
    // while the real executor sat in the same runtime, unused and silent.
    // Refusing to build is what keeps that mistake from shipping.
    expect(() => AppNodeBuilder.build(LayerNode.group([JobScheduler.node]))).toThrow(/Unbound layer node/)
  })

  it("takes the executor a graph installs", () => {
    expect(() =>
      AppNodeBuilder.build(LayerNode.group([JobScheduler.node]), [[JobExecutor.node, JobExecutor.unconfigured]]),
    ).not.toThrow()
  })
})
