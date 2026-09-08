import { describe, expect, it } from "bun:test"
import { JobExecutorSession } from "@opencode-ai/core/job/executor-session"

const job = { objective: "find billing bugs in the voice service" }
const worker = { role: "scout-backend" }

describe("JobExecutorSession.brief", () => {
  it("gives the worker its role and the job's objective", () => {
    const text = JobExecutorSession.brief({ job, worker })
    expect(text).toContain("scout-backend")
    expect(text).toContain("find billing bugs in the voice service")
  })

  it("asks the worker to say what it could not establish", () => {
    // A scout that reports only what it found, and stays quiet about what it
    // could not check, produces an audit that reads as more complete than it is.
    expect(JobExecutorSession.brief({ job, worker })).toContain("could not establish")
  })
})
