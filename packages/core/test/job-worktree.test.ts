import { describe, expect, it } from "bun:test"
import { Job } from "@opencode-ai/schema/job"
import { JobWorktree } from "@opencode-ai/core/job/worktree"

const jobID = Job.ID.make("job_08044e8ab001abcdefgh")
const workerID = Job.WorkerID.make("wrk_08044e8ab001zyxwvuts")

describe("JobWorktree.writes", () => {
  it("does not isolate roles that only read", () => {
    // A scout that greps has nothing to isolate, and a checkout per scout is a
    // checkout wasted.
    for (const role of ["scout", "auditor", "reviewer", "planner", "researcher"])
      expect(JobWorktree.writes(role)).toBe(false)
  })

  it("treats a qualified read-only role as read-only", () => {
    expect(JobWorktree.writes("scout-backend")).toBe(false)
    expect(JobWorktree.writes("auditor-security")).toBe(false)
  })

  it("isolates roles that write", () => {
    for (const role of ["fixer", "coder", "migrator"]) expect(JobWorktree.writes(role)).toBe(true)
  })

  it("isolates a role nobody classified", () => {
    // The default has to be isolation: an unclassified role given a worktree it
    // does not need costs a checkout, while one denied a worktree it does need
    // writes into a tree it shares with others.
    expect(JobWorktree.writes("something-new")).toBe(true)
  })

  it("does not mistake a prefix for a read-only role", () => {
    // "scouting" is not "scout"; matching on prefix alone would silently let it
    // write into the shared checkout.
    expect(JobWorktree.writes("scoutmaster")).toBe(true)
  })
})

describe("JobWorktree.directory", () => {
  const target = JobWorktree.directory({
    root: "/home/user/.local/share/opencode",
    projectID: "engrana",
    jobID,
    workerID,
    role: "fixer",
  })

  it("separates trees by project, job and worker", () => {
    expect(target).toContain("/worktrees/engrana/")
    expect(target).toContain(jobID)
    expect(target.endsWith("fixer-08044e8a")).toBe(true)
  })

  it("keeps two workers of the same role apart", () => {
    const other = JobWorktree.directory({
      root: "/root",
      projectID: "engrana",
      jobID,
      workerID: Job.WorkerID.make("wrk_99944e8ab001aaaaaaaa"),
      role: "fixer",
    })
    // Two fixers sharing a directory produce a diff belonging to neither.
    expect(other).not.toBe(
      JobWorktree.directory({ root: "/root", projectID: "engrana", jobID, workerID, role: "fixer" }),
    )
  })
})

describe("JobWorktree.branch", () => {
  it("names a branch after the job and worker", () => {
    const name = JobWorktree.branch({ jobID, workerID, role: "fixer" })
    expect(name.startsWith("job/")).toBe(true)
    expect(name).toContain("fixer")
    // Git refuses branch names with spaces or a trailing slash; keep it simple.
    expect(name).not.toContain(" ")
  })
})
