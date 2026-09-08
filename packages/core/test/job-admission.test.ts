import { describe, expect, it } from "bun:test"
import { Job } from "@opencode-ai/schema/job"
import { JobAdmission } from "@opencode-ai/core/job/admission"

let clock = 0
const candidate = (input: {
  readonly id: string
  readonly provider?: string
  readonly model?: string
  readonly project?: string
  readonly priority?: number
}): JobAdmission.Candidate => ({
  workerID: Job.WorkerID.make(`wrk_${input.id}`),
  jobID: Job.ID.make("job_test"),
  projectID: input.project ?? "project-a",
  requested: { providerID: input.provider ?? "mistral", modelID: input.model ?? "codestral" },
  ...(input.priority === undefined ? {} : { priority: input.priority }),
  enqueuedAt: clock++,
})

const running = (input: { readonly provider?: string; readonly model?: string; readonly project?: string }) => ({
  projectID: input.project ?? "project-a",
  providerID: input.provider ?? "mistral",
  modelID: input.model ?? "codestral",
})

const ids = (admitted: ReadonlyArray<JobAdmission.Candidate>) =>
  admitted.map((item) => item.workerID.replace("wrk_", ""))

describe("JobAdmission.admit", () => {
  it("fills the free slots and no more", () => {
      const admitted = JobAdmission.admit({
        candidates: [candidate({ id: "a" }), candidate({ id: "b" }), candidate({ id: "c" })],
        running: [],
        limits: { global: 2 },
      })
      expect(ids(admitted)).toEqual(["a", "b"])
  })

  it("counts what is already running against the ceiling", () => {
      const admitted = JobAdmission.admit({
        candidates: [candidate({ id: "a" }), candidate({ id: "b" })],
        running: [running({}), running({})],
        limits: { global: 3 },
      })
      expect(ids(admitted)).toEqual(["a"])
  })

  it("the batch competes with itself for the same slots", () => {
      // Three candidates on one model with a per-model limit of two: the third
      // must see the first two take their slots, not only what was running.
      const admitted = JobAdmission.admit({
        candidates: [candidate({ id: "a" }), candidate({ id: "b" }), candidate({ id: "c" })],
        running: [],
        limits: { global: 10, perModel: 2 },
      })
      expect(ids(admitted)).toEqual(["a", "b"])
  })

  it("a saturated provider does not idle slots the others could use", () => {
      const admitted = JobAdmission.admit({
        candidates: [
          candidate({ id: "mistral-1", provider: "mistral" }),
          candidate({ id: "mistral-2", provider: "mistral" }),
          candidate({ id: "anthropic", provider: "anthropic", model: "claude-haiku-4-5" }),
        ],
        running: [running({ provider: "mistral" })],
        limits: { global: 4, perProvider: 2 },
      })
      // Mistral is full after one more; the Anthropic worker needs none of that
      // capacity, so blocking it behind the queue would waste a free slot.
      expect(ids(admitted)).toEqual(["mistral-1", "anthropic"])
  })

  it("keeps one project from taking the whole pool", () => {
      const admitted = JobAdmission.admit({
        candidates: [
          candidate({ id: "a1", project: "a" }),
          candidate({ id: "a2", project: "a" }),
          candidate({ id: "a3", project: "a" }),
          candidate({ id: "b1", project: "b" }),
        ],
        running: [],
        limits: { global: 4, perProject: 2 },
      })
      expect(ids(admitted)).toEqual(["a1", "a2", "b1"])
  })

  it("runs priority first and breaks ties on arrival", () => {
      const first = candidate({ id: "old" })
      const second = candidate({ id: "new" })
      const urgent = candidate({ id: "urgent", priority: 10 })
      const admitted = JobAdmission.admit({
        candidates: [second, urgent, first],
        running: [],
        limits: { global: 3 },
      })
      // Equal priorities fall back to arrival, so nothing is starved by newer work.
      expect(ids(admitted)).toEqual(["urgent", "old", "new"])
  })

  it("admits nothing when the pool is full", () => {
      expect(
        JobAdmission.admit({
          candidates: [candidate({ id: "a" })],
          running: [running({}), running({})],
          limits: { global: 2 },
        }),
      ).toHaveLength(0)
  })

  it("an absent limit does not constrain", () => {
      const admitted = JobAdmission.admit({
        candidates: Array.from({ length: 5 }, (_, index) => candidate({ id: `w${index}` })),
        running: [],
        limits: { global: 5 },
      })
      expect(admitted).toHaveLength(5)
  })
})
