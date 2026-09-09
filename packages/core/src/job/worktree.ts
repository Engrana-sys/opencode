export * as JobWorktree from "./worktree"

import path from "path"
import { Context, Effect, Layer } from "effect"
import type { Job } from "@opencode-ai/schema/job"
import { makeGlobalNode } from "../effect/app-node"
import { Git } from "../git"
import { Global } from "../global"
import { AbsolutePath } from "../schema"

/**
 * Isolates workers that write.
 *
 * Two workers editing the same checkout produce a diff that belongs to neither
 * of them, and neither can be verified or reverted on its own. So a writing
 * worker gets its own git worktree and a branch named after it, while readers
 * share the project checkout read-only — a scout that only greps has nothing to
 * isolate, and giving it a worktree would cost a checkout per scout for nothing.
 *
 * The base commit is pinned when the worktree is created and recorded on the
 * worker. Workers of one job then start from the same tree even if the branch
 * moves under them mid-job, which is what makes their diffs comparable.
 *
 * @module
 */

/** Roles that only read. Everything else is assumed to write and gets isolated. */
export const READ_ONLY_ROLES: ReadonlyArray<string> = ["scout", "auditor", "reviewer", "planner", "researcher"]

/**
 * Whether a role needs its own tree.
 *
 * The default is to isolate: a role nobody classified is more safely given a
 * worktree it does not need than allowed to write into a shared checkout.
 */
export const writes = (role: string) =>
  !READ_ONLY_ROLES.some((readOnly) => role === readOnly || role.startsWith(`${readOnly}-`))

/** `~/.local/share/opencode/worktrees/<project>/<job>/<role>-<worker>`. */
export const directory = (input: {
  readonly root: string
  readonly projectID: string
  readonly jobID: Job.ID
  readonly workerID: Job.WorkerID
  readonly role: string
}) =>
  AbsolutePath.make(
    path.join(
      input.root,
      "worktrees",
      input.projectID,
      input.jobID,
      // The whole worker ID, not a prefix of it: the leading half of an ID is a
      // millisecond clock, so two workers of one role created in the same loop
      // would otherwise be handed the same tree and produce a diff belonging to
      // neither. The role only keeps the path readable for whoever has to go
      // and look at a dirty tree.
      `${input.role}-${input.workerID.replace("wrk_", "")}`,
    ),
  )

/** Whole IDs, for the reason `directory` gives: a prefix of one is a clock. */
export const branch = (input: { readonly jobID: Job.ID; readonly workerID: Job.WorkerID; readonly role: string }) =>
  `job/${input.jobID.replace("job_", "")}/${input.role}-${input.workerID.replace("wrk_", "")}`

export interface Interface {
  /**
   * A worktree for a worker that writes, or undefined for one that only reads.
   * Safe to call again for the same worker: an existing tree is reused.
   */
  readonly provision: (input: {
    readonly job: Job.Info
    readonly workerID: Job.WorkerID
    readonly role: string
  }) => Effect.Effect<Job.Worktree | undefined>
  /**
   * Releases a worktree once its worker is finished with it. A tree with
   * uncommitted work is kept: it is the only copy of what the worker did.
   */
  readonly release: (input: {
    readonly worktree: Job.Worktree
    readonly force: boolean
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/JobWorktree") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const global = yield* Global.Service

    /** The tree standing at `target` already, when one is. */
    const adopt = Effect.fn("JobWorktree.adopt")(function* (repository: Git.Repository, target: AbsolutePath) {
      const existing = yield* git.worktree.list(repository).pipe(Effect.catch(() => Effect.succeed([])))
      if (!existing.some((item) => item.directory === target)) return undefined
      return yield* git.repo.discover(target)
    })

    return Service.of({
      provision: Effect.fn("JobWorktree.provision")(function* (input) {
        if (!writes(input.role)) return undefined
        const repository = yield* git.repo.discover(AbsolutePath.make(input.job.directory))
        // Not every project is a git repository. A worker in one of those keeps
        // working in the project directory rather than being refused outright.
        if (!repository) return undefined
        const target = directory({
          root: global.data,
          projectID: input.job.projectID,
          jobID: input.job.id,
          workerID: input.workerID,
          role: input.role,
        })
        const created = yield* git.worktree
          .create({ repository, directory: target })
          // Provisioning is neither exclusive nor atomic with the event that
          // records it: two ticks can admit one worker at once, and a process
          // that dies after `worktree add` comes back with the worker still
          // holding no tree. `add` then refuses the path forever. A tree at this
          // worker's own path is this worker's, so adopt it rather than leave a
          // writer loose in the shared checkout with nothing saying so.
          .pipe(Effect.catch(() => adopt(repository, target)))
        if (!created) return undefined
        const head = yield* git.history.head(created).pipe(Effect.catch(() => Effect.succeed(undefined)))
        return {
          repo: repository.worktree,
          baseRef: input.job.baseRef ?? (yield* git.history.branch(repository).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )) ?? "HEAD",
          baseSha: head ?? "",
          branch: branch({ jobID: input.job.id, workerID: input.workerID, role: input.role }),
          directory: created.worktree,
        }
      }),

      release: Effect.fn("JobWorktree.release")(function* (input) {
        const repository = yield* git.repo.discover(AbsolutePath.make(input.worktree.repo))
        if (!repository) return false
        return yield* git.worktree
          .remove({ repository, directory: AbsolutePath.make(input.worktree.directory), force: input.force })
          .pipe(
            Effect.as(true),
            // Removal fails on a dirty tree unless forced, and that failure is
            // the point: uncommitted work is the only record of what the worker
            // did, and deleting it to tidy up would destroy the evidence.
            Effect.catch(() => Effect.succeed(false)),
          )
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Git.node, Global.node] })
