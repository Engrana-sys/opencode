import { describe, expect, it } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { JobVerification } from "@opencode-ai/schema/job-verification"
import { Job } from "@opencode-ai/schema/job"
import { JobVerifier } from "@opencode-ai/core/job/verifier"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { git } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const effect = testEffect(LayerNode.compile(JobVerifier.node))
const jobID = Job.ID.make("job_08044e8ab001abcdefgh")

const result = (
  name: string,
  outcome: JobVerification.CheckOutcome,
  detail = "",
): JobVerification.Result => ({ name, outcome, detail })

describe("JobVerification.verdict", () => {
  it("verifies only when every check ran and passed", () => {
    expect(JobVerification.verdict([result("tests", "passed"), result("lint", "passed")])).toBe("verified")
  })

  it("one failure refutes the whole candidate", () => {
    // A candidate that breaks one thing is not partially correct.
    expect(JobVerification.verdict([result("tests", "passed"), result("lint", "failed")])).toBe("refuted")
  })

  it("a check that could not run leaves the candidate unverified", () => {
    // Claiming a pass when part of the evidence was never gathered is the one
    // failure mode a verifier must not have.
    expect(JobVerification.verdict([result("tests", "passed"), result("build", "errored")])).toBe("unverified")
    expect(JobVerification.verdict([result("tests", "passed"), result("build", "skipped")])).toBe("unverified")
  })

  it("a real failure outranks a check that could not run", () => {
    // Something is definitely broken; not knowing about the rest does not
    // soften that.
    expect(JobVerification.verdict([result("build", "errored"), result("tests", "failed")])).toBe("refuted")
  })

  it("checking nothing proves nothing", () => {
    // Defaulting to verified would make an unconfigured verifier the most
    // permissive one in the system.
    expect(JobVerification.verdict([])).toBe("unverified")
  })

  it("describes what happened in each category", () => {
    const results = [result("a", "passed"), result("b", "failed"), result("c", "errored")]
    expect(JobVerification.describe({ verdict: JobVerification.verdict(results), results })).toBe(
      "REFUTED: 1 passed 1 failed 1 could not run 0 skipped",
    )
  })
})

describe("JobVerifier.inspect", () => {
  it("passes a diff that stays inside the allowed paths", () => {
    expect(
      JobVerifier.inspect({ files: ["packages/core/src/a.ts"], allow: ["packages/core/**"] }).ok,
    ).toBe(true)
  })

  it("fails a diff that reaches outside them", () => {
    const seen = JobVerifier.inspect({
      files: ["packages/core/src/a.ts", "infra/deploy.ts"],
      allow: ["packages/core/**"],
    })
    expect(seen.ok).toBe(false)
    expect(seen.detail).toContain("infra/deploy.ts")
  })

  it("an empty allow list permits anything", () => {
    // No allowlist means the check is about forbidden paths only; treating it
    // as "allow nothing" would fail every diff.
    expect(JobVerifier.inspect({ files: ["anywhere.ts"] }).ok).toBe(true)
  })

  it("a forbid rule carves out of what allow permitted", () => {
    // Applied after allow on purpose: a broad allow must not silently override
    // the narrow rule that exists to stop exactly this.
    const seen = JobVerifier.inspect({
      files: ["packages/core/src/a.ts", "packages/core/src/secrets.ts"],
      allow: ["packages/core/**"],
      forbid: ["**/secrets.ts"],
    })
    expect(seen.ok).toBe(false)
    expect(seen.detail).toContain("secrets.ts")
  })

  it("reports both kinds of violation at once", () => {
    const seen = JobVerifier.inspect({
      files: ["infra/deploy.ts", "packages/core/src/secrets.ts"],
      allow: ["packages/core/**"],
      forbid: ["**/secrets.ts"],
    })
    expect(seen.detail).toContain("Outside the allowed paths")
    expect(seen.detail).toContain("Forbidden paths touched")
  })

  it("a diff touching nothing passes", () => {
    expect(JobVerifier.inspect({ files: [], allow: ["packages/**"] }).ok).toBe(true)
  })
})

describe("JobVerifier files check", () => {
  const paths = (input: { allow?: ReadonlyArray<string>; forbid?: ReadonlyArray<string> }): JobVerification.Check => ({
    name: "paths",
    type: "files",
    ...input,
  })

  effect.live("sees both paths of a rename", () =>
    withRepo(
      (project) => git(project, "mv", "secrets.lock", "renamed.txt"),
      (repo) =>
        Effect.gen(function* () {
          const verifier = yield* JobVerifier.Service
          // Porcelain reports a rename as one line naming two paths. Read as a
          // single path it is neither of them, and `git mv secrets.lock` walks
          // past the rule that exists to stop exactly that.
          const info = yield* verifier.verify({
            checks: [paths({ forbid: ["*.lock"] })],
            directory: repo.project,
            jobID,
          })
          expect(info.verdict).toBe("refuted")
          expect(info.results[0].detail).toContain("secrets.lock")
        }),
    ),
  )

  effect.live("looks inside a directory the worker created", () =>
    withRepo(
      async (project) => {
        await fs.mkdir(path.join(project, "newdir/inner"), { recursive: true })
        await fs.writeFile(path.join(project, "newdir/inner/.env"), "SECRET=1\n")
      },
      (repo) =>
        Effect.gen(function* () {
          const verifier = yield* JobVerifier.Service
          // Git collapses an untracked directory to a single entry, so a worker
          // that put its forbidden files one level down is judged on the name of
          // the directory rather than on anything it wrote.
          const info = yield* verifier.verify({
            checks: [paths({ forbid: ["**/*.env"] })],
            directory: repo.project,
            jobID,
          })
          expect(info.verdict).toBe("refuted")
          expect(info.results[0].detail).toContain("newdir/inner/.env")
        }),
    ),
  )

  effect.live("does not refute a permitted path because git quoted it", () =>
    withRepo(
      async (project) => {
        await fs.writeFile(path.join(project, "src/with space.ts"), "two\n")
        await fs.writeFile(path.join(project, "src/naïve.ts"), "two\n")
      },
      (repo) =>
        Effect.gen(function* () {
          const verifier = yield* JobVerifier.Service
          // Git C-quotes a path holding a space or a non-ASCII byte. Kept, the
          // quotes match no glob, and a worker that stayed inside its allowed
          // subtree is reported for a violation that did not happen.
          const info = yield* verifier.verify({
            checks: [paths({ allow: ["src/**"] })],
            directory: repo.project,
            jobID,
          })
          expect(info.verdict).toBe("verified")
        }),
    ),
  )

  effect.live("sees work the worker committed", () =>
    withRepo(
      async (project) => {
        await fs.mkdir(path.join(project, ".github/workflows"), { recursive: true })
        await git(project, "mv", "src/a.ts", ".github/workflows/ci.yml")
        await git(project, "commit", "-m", "work")
      },
      (repo) =>
        Effect.gen(function* () {
          const verifier = yield* JobVerifier.Service
          // Committing is the normal end state for a worker that owns its tree,
          // and it empties `git status`. Judged on the working tree alone the
          // check reports nothing changed for a worker that changed everything
          // it was forbidden to.
          const info = yield* verifier.verify({
            checks: [paths({ forbid: [".github/**"] })],
            directory: repo.project,
            base: repo.base,
            jobID,
          })
          expect(info.verdict).toBe("refuted")
          expect(info.results[0].detail).toContain(".github/workflows/ci.yml")
        }),
    ),
  )
})

/** A repository with one commit, then whatever the worker did to it. */
function withRepo<A, E, R>(
  worker: (project: string) => Promise<unknown>,
  body: (repo: { project: string; base: string }) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await tmpdir()
      const project = path.join(root.path, "project")
      await fs.mkdir(path.join(project, "src"), { recursive: true })
      await git(project, "init")
      await git(project, "config", "user.email", "test@example.com")
      await git(project, "config", "user.name", "Test")
      await fs.writeFile(path.join(project, "src/a.ts"), "one\n")
      await fs.writeFile(path.join(project, "secrets.lock"), "one\n")
      await git(project, "add", "-A")
      await git(project, "commit", "-m", "root")
      const base = (await $`git rev-parse HEAD`.cwd(project).text()).trim()
      await worker(project)
      return { root, repo: { project, base } }
    }),
    (input) => body(input.repo),
    (input) => Effect.promise(() => input.root[Symbol.asyncDispose]()),
  )
}
