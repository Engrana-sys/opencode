import { describe, expect, it } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Job } from "@opencode-ai/schema/job"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { JobWorktree } from "@opencode-ai/core/job/worktree"
import { git } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { it as effect } from "./lib/effect"

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
    expect(target.endsWith(`fixer-${workerID.replace("wrk_", "")}`)).toBe(true)
  })

  it("keeps two workers of the same role apart", () => {
    // Minted the way a fan-out step mints them, back to back: the leading half
    // of an ID is a millisecond clock, so IDs written by hand to differ early
    // prove nothing about the two a job actually hands out.
    const first = Job.WorkerID.create()
    const second = Job.WorkerID.create()
    const tree = (worker: Job.WorkerID) =>
      JobWorktree.directory({ root: "/root", projectID: "engrana", jobID, workerID: worker, role: "fixer" })
    // Two fixers sharing a directory produce a diff belonging to neither.
    expect(tree(second)).not.toBe(tree(first))
    expect(JobWorktree.branch({ jobID, workerID: second, role: "fixer" })).not.toBe(
      JobWorktree.branch({ jobID, workerID: first, role: "fixer" }),
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

describe("JobWorktree.provision", () => {
  effect.live("adopts the tree a worker already has", () =>
    withRepo((repo) =>
      Effect.gen(function* () {
        const worktrees = yield* JobWorktree.Service
        const job = {
          id: jobID,
          projectID: "engrana",
          directory: repo.project,
        } as unknown as Job.Info
        const first = yield* worktrees.provision({ job, workerID, role: "fixer" })
        // A worker whose tree was created but whose assignment never committed
        // comes back holding nothing, and `git worktree add` refuses that path
        // for good. Returning undefined here would put a writer into the shared
        // checkout with nothing in the ledger saying isolation was lost.
        const again = yield* worktrees.provision({ job, workerID, role: "fixer" })
        expect(first?.directory).toBe(
          JobWorktree.directory({ root: repo.data, projectID: "engrana", jobID, workerID, role: "fixer" }),
        )
        expect(again?.directory).toBe(first?.directory)
        expect(again?.baseSha).toBe(first!.baseSha)
      }).pipe(Effect.provide(layer(repo.data))),
    ))
})

/** The service, pointed at a throwaway data root instead of the real one. */
const layer = (data: string) =>
  LayerNode.compile(JobWorktree.node, [
    [Global.node, Layer.succeed(Global.Service, Global.Service.of(Global.make({ data })))],
  ])

function withRepo<A, E, R>(body: (repo: { project: string; data: string }) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await tmpdir()
      const project = path.join(root.path, "project")
      await fs.mkdir(project, { recursive: true })
      await git(project, "init")
      await git(project, "config", "user.email", "test@example.com")
      await git(project, "config", "user.name", "Test")
      await git(project, "commit", "--allow-empty", "-m", "root")
      return { root, repo: { project, data: path.join(root.path, "data") } }
    }),
    (input) => body(input.repo),
    (input) => Effect.promise(() => input.root[Symbol.asyncDispose]()),
  )
}
