/**
 * Per-area audit of the job harness.
 *
 * Kept in the repository rather than only in a session's scratch directory
 * because what it asserts about the code is worth reviewing alongside the code,
 * and because the first run of it produced a result that read as an audit and
 * was not one.
 *
 * That run launched 451 agents and 407 of them died against a session limit.
 * Two things caused it, and both are fixed here:
 *
 * 1. **Shape.** Verification ran three skeptics per FINDING, so its cost grew
 *    with the number of findings — the one quantity nobody controls — and the
 *    same files were re-read once per finding. It now runs three skeptics per
 *    AREA, each judging that area's whole batch. The votes stay independent,
 *    which is the reason for having three; only the fan-out collapses, from
 *    roughly 408 agents to 21.
 *
 * 2. **Accounting.** A dead agent returned undefined, which the survival test
 *    read as a refutation. Findings nobody had looked at were reported as
 *    rejected by three skeptics. There are now three buckets — survived,
 *    refuted, and `unjudged` — and `unjudged` never reaches a fixer. Absence of
 *    evidence is not evidence of absence, and a run that dies should say so
 *    rather than presenting its own silence as a clean bill of health.
 *
 * Fan-out: 7 analyse + 28 hunt + 21 verify + at most 7 fix, 7 review and 1
 * critic — 71 at the ceiling.
 */

export const meta = {
  name: 'harness-audit',
  description: 'Per-area audit of the job harness: analyse, hunt bugs, adversarially verify, fix serially, review',
  phases: [
    { title: 'Analyse', detail: 'one reader per area builds the model to hunt against' },
    { title: 'Hunt', detail: 'four distinct lenses per area' },
    { title: 'Verify', detail: 'three skeptics per area, each judging the whole batch for that area' },
    { title: 'Fix', detail: 'serial, one area at a time, suite green after each' },
    { title: 'Review', detail: 'a different agent reviews each applied diff' },
  ],
}

const REPO = '/home/user/opencode'
const BASELINE = `Test baseline: from ${REPO}/packages/core, \`bun test\` gives 1211 pass / 2 fail. The 2 failures are util.flock "fails clearly on unwritable lock roots" and util.effect-flock "fails on unwritable lock roots" — they are PRE-EXISTING, unrelated to this work, and fail only because the suite runs as root (everything is writable, so the expected permission error never happens). Never report them as regressions.`

const CONTEXT = `You are auditing a job/harness subsystem recently added to a fork of opencode (Effect-TS, Bun, SQLite via drizzle) at ${REPO}. It was all written in one long session by a single author with no independent review, and its tests were written by that same author — so the tests share the author's blind spots. A passing test only proves the code does what the author believed it should.

Design rules the subsystem claims to hold (violations of these are real bugs):
1. The \`event\` table is append-only. Nothing updates or deletes a row in it. State lives in projections that can be dropped and rebuilt.
2. Projection handlers are replayable: idempotent or keyed by an id the event carries. Replaying an event twice yields the same rows.
3. History is never overwritten. A retried worker gains an attempt rather than mutating the previous one. A terminal job stays terminal.
4. Requested and resolved models are separate persisted facts; every divergence emits an event naming both plus a reason.
5. Permissions intersect, never union. A child worker can never end up more permissive than its parent.
6. A worker that writes owns its own git worktree; readers share the checkout. Two writing workers never share a directory.
7. Every RUNNING worker holds a lease. No valid lease means not running, whatever the status column says. Recovery trusts the lease, not the status.
8. Budgets are enforced, not advisory: exhausting one settles the work rather than logging and continuing.
9. Ordinary opencode still works — sessions with no job behave exactly as before.

Known and deliberate gaps — these are NOT bugs, do not report them:
- A session does not yet accept an explicit permission ruleset to run under, so a worker's clamped ruleset is stored and auditable but not enforced inside its session. Documented in executor-session.ts.
- No sandbox backend exists yet (landlock/bubblewrap/container).
- No TUI or public HTTP API for jobs.
- Nothing creates jobs yet in production paths; the scheduler runs but has no source of work.

Already found and fixed by an earlier review — do NOT report these again, and do not "fix" them a second time:
- projector.ts StatusChanged rewrote time_started on every entry into \`running\`, resetting the job's wall-clock budget. It now uses COALESCE so only the first entry counts.
- A worker entering \`running\` had no lease until its first heartbeat, two separate durable writes apart, and JobStore.expired treats a running worker with a null lease as abandoned. The WorkerStatusChanged projection now grants the lease with the transition itself.`

const ANALYSIS = {
  type: 'object',
  properties: {
    purpose: { type: 'string', description: 'What this area does, in two or three sentences' },
    invariants: {
      type: 'array',
      items: { type: 'string' },
      description: 'What the code claims to guarantee, including from its comments',
    },
    dependencies: { type: 'array', items: { type: 'string' } },
    riskSurface: {
      type: 'array',
      items: { type: 'string' },
      description: 'Where this area is most likely to be wrong and why',
    },
  },
  required: ['purpose', 'invariants', 'riskSurface'],
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Repo-relative path' },
          line: { type: 'integer' },
          title: { type: 'string', description: 'One line, the claim alone' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          failureScenario: {
            type: 'string',
            description: 'Concrete inputs or interleaving that produce the wrong outcome. No hand-waving.',
          },
          suggestedFix: { type: 'string' },
        },
        required: ['file', 'title', 'severity', 'failureScenario'],
      },
    },
  },
  required: ['findings'],
}

// One skeptic judges a whole batch, so the schema is a list of verdicts keyed
// by the index it was given. Judging one finding per agent made this phase 90%
// of the run and re-read the same files once per finding.
const VERDICTS = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The number the finding was listed under' },
          refuted: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['index', 'refuted', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}

const FIX = {
  type: 'object',
  properties: {
    applied: { type: 'boolean' },
    reverted: { type: 'boolean' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    suiteAtBaseline: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['applied', 'reverted', 'summary', 'suiteAtBaseline'],
}

const REVIEW = {
  type: 'object',
  properties: {
    sound: { type: 'boolean' },
    concerns: { type: 'array', items: { type: 'string' } },
    testProvesFix: { type: 'boolean', description: 'Would the added test fail without the fix?' },
  },
  required: ['sound', 'concerns'],
}

const AREAS = [
  {
    key: 'ledger',
    name: 'Ledger and domain',
    files: [
      'packages/schema/src/job.ts',
      'packages/schema/src/job-event.ts',
      'packages/core/src/job/sql.ts',
      'packages/core/src/job/projector.ts',
      'packages/core/src/job/store.ts',
    ],
    focus:
      'Projection idempotency and replayability; whether every event handler is keyed so a double replay is a no-op; whether the status-transition table and terminal states are coherent; whether store row mapping loses or invents fields; the usage roll-up done with SQL increments (what happens on replay?).',
  },
  {
    key: 'service',
    name: 'Job service',
    files: ['packages/core/src/job.ts'],
    focus:
      'Transition validation; the permission clamp on createWorker; depth and worker-count limits; whether any write bypasses the ledger; read-then-write races between checking state and publishing an event.',
  },
  {
    key: 'scheduler',
    name: 'Scheduler, admission, retry, budget',
    files: [
      'packages/core/src/job/scheduler.ts',
      'packages/core/src/job/admission.ts',
      'packages/core/src/job/retry.ts',
      'packages/core/src/job/budget.ts',
    ],
    focus:
      'Double-admission of the same worker across overlapping ticks; the wake/forkDetach loop and whether it can recurse or storm; occupancy read from the DB versus workers this process started; retry attempt counting; budget elapsed-time when timeStarted is unset; the FiberSet lifetime.',
  },
  {
    key: 'recovery',
    name: 'Recovery and leases',
    files: ['packages/core/src/job/recovery.ts', 'packages/core/src/job/store.ts'],
    focus:
      'Which worker statuses require a lease and whether that set is right; whether recovery can reclaim work that is actually running; whether a scan is safe to run concurrently with the scheduler starting a worker; the disposition rule based on worktree presence.',
  },
  {
    key: 'executor',
    name: 'Executors and worktrees',
    files: [
      'packages/core/src/job/executor.ts',
      'packages/core/src/job/executor-session.ts',
      'packages/core/src/job/worktree.ts',
    ],
    focus:
      'The error-to-exit-reason mapping by regex (false positives? a real failure classified as retryable forever?); worktree path and branch collisions; whether provisioning is idempotent; whether a session is left running if the attempt is interrupted; the read-only role classification.',
  },
  {
    key: 'verifier',
    name: 'Verifier and capability',
    files: [
      'packages/core/src/job/verifier.ts',
      'packages/schema/src/job-verification.ts',
      'packages/core/src/permission/capability.ts',
    ],
    focus:
      'Whether a check that could not run can ever be reported as passed; the allow/forbid ordering; git status --porcelain parsing (renames, quoted paths with spaces, untracked); whether clamp can be defeated by rule ordering or wildcard shape; whether effective() is right for a chain longer than two.',
  },
  {
    key: 'session',
    name: 'Session goal, loop and context',
    files: [
      'packages/core/src/session/goal.ts',
      'packages/core/src/session/loop.ts',
      'packages/core/src/session/guidance.ts',
      'packages/core/src/session/goal-evaluator.ts',
      'packages/core/src/session/system-model.ts',
      'packages/core/src/session/loop-scheduler.ts',
      'packages/core/src/tool/goal.ts',
      'packages/core/src/tool/loop.ts',
      'packages/core/src/tool/loop-schedule.ts',
    ],
    focus:
      'Whether the goal continuation loop can run away or spend its budget wrongly; the loop scheduler admitting duplicate iterations across ticks; Context Source codec equality causing needless or missing system messages; the system-model chain when every entry fails; interaction with the session drain loop in runner/llm.ts.',
  },
]

const LENSES = [
  {
    key: 'correctness',
    prompt:
      'Logic errors: wrong conditions, off-by-one, inverted booleans, unreachable branches, a ternary that can never pick one side, a computed value that is never used, error paths that swallow the error.',
  },
  {
    key: 'concurrency',
    prompt:
      'Concurrency and ordering: read-then-write races, two ticks overlapping, a fiber outliving its scope, check-then-act on database state, interleavings where two callers both think they won, work started twice or lost.',
  },
  {
    key: 'durability',
    prompt:
      'Durability and replay: whether replaying the ledger reproduces the projections exactly, whether any handler is non-idempotent (SQL increments are prime suspects), what a crash mid-sequence leaves behind, and whether state that must survive a restart actually does.',
  },
  {
    key: 'escape',
    prompt:
      'Security and escapes: whether a permission clamp can be circumvented, whether two workers can write to the same path, whether a value from an untrusted source reaches a shell or a path unescaped, whether a limit meant to bound something can be bypassed.',
  },
]

phase('Analyse')
log(`Auditing ${AREAS.length} areas across ${AREAS.reduce((n, a) => n + a.files.length, 0)} files`)

// Analyse then hunt, per area, with no barrier: an area that reads fast starts
// hunting while another is still reading.
const hunted = await pipeline(
  AREAS,
  (area) =>
    agent(
      `${CONTEXT}\n\nRead these files in full and build a model of what this area does. Do NOT look for bugs yet — this is the model that the bug hunt will be run against.\n\nArea: ${area.name}\nFiles:\n${area.files.map((f) => `- ${REPO}/${f}`).join('\n')}\n\nAlso read any test file covering them (${REPO}/packages/core/test/) so you know what is already asserted.\n\nBe specific about the risk surface: name the exact function or line where this area is most likely to be wrong, and why.`,
      { label: `analyse:${area.key}`, phase: 'Analyse', schema: ANALYSIS },
    ),
  (analysis, area) =>
    parallel(
      LENSES.map((lens) => () =>
        agent(
          `${CONTEXT}\n\n${BASELINE}\n\nHunt for defects in ONE area through ONE lens.\n\nArea: ${area.name}\nFiles:\n${area.files.map((f) => `- ${REPO}/${f}`).join('\n')}\n\nWhat the area is meant to do (from a prior reader):\n${analysis ? JSON.stringify(analysis, null, 2) : '(analysis unavailable — read the files yourself)'}\n\nKnown risk areas for this code: ${area.focus}\n\nYOUR LENS — ${lens.key}: ${lens.prompt}\n\nRules:\n- Read the actual files. Do not speculate from the summary alone.\n- Every finding needs a CONCRETE failure scenario: specific inputs, or a specific interleaving of two operations, that produces a wrong outcome. "This could be racy" is not a finding; "tick A reads status=queued at T1, tick B reads the same row at T2 before A writes, both call start()" is.\n- Do not report style, naming, missing comments, or hypothetical future features.\n- Do not report the known deliberate gaps listed above.\n- If you find nothing real through your lens, return an empty findings array. That is a perfectly good answer and much better than padding.`,
          { label: `hunt:${area.key}:${lens.key}`, phase: 'Hunt', schema: FINDINGS },
        ),
      ),
    ).then((rounds) => ({
      area,
      findings: rounds.filter(Boolean).flatMap((r) => r.findings || []),
    })),
)

const collected = hunted.filter(Boolean)
// Dedup across lenses: four lenses on one area often see the same defect.
const seen = new Set()
const perArea = new Map()
let dropped = 0
const RANK = { high: 0, medium: 1, low: 2 }
const CAP = 8
for (const entry of collected)
  for (const finding of entry.findings) {
    const key = `${finding.file}:${finding.line || 0}:${finding.title.slice(0, 60).toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    // A `low` finding will not be fixed even if it survives, so paying three
    // skeptics to judge it buys nothing. Recorded, not judged.
    if (finding.severity === 'low') {
      dropped++
      continue
    }
    if (!perArea.has(entry.area.key)) perArea.set(entry.area.key, [])
    perArea.get(entry.area.key).push({ ...finding, area: entry.area.key, areaName: entry.area.name })
  }

// An area yielding thirty findings is producing noise, not signal. Keep the
// worst of them and say how many were left unjudged rather than pretending the
// tail was examined.
let capped = 0
const candidates = []
for (const [key, list] of perArea) {
  list.sort((a, b) => RANK[a.severity] - RANK[b.severity])
  if (list.length > CAP) capped += list.length - CAP
  perArea.set(key, list.slice(0, CAP))
  candidates.push(...perArea.get(key))
}

log(`${candidates.length} candidates to verify (${dropped} low dropped, ${capped} over the per-area cap of ${CAP})`)

phase('Verify')
// Three skeptics per AREA, each judging that area's whole batch — not three per
// finding. The votes stay independent, which is the whole point of having
// three, but the area's files are read three times instead of three times per
// finding. That single change is what took this phase from ~408 agents to 21.
const judgedByArea = await parallel(
  [...perArea.entries()]
    .filter(([, batch]) => batch.length > 0)
    .map(([key, batch]) => () => {
      const area = AREAS.find((a) => a.key === key)
      const listing = batch
        .map(
          (f, i) =>
            `${i}. [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.title}\n   Claimed failure: ${f.failureScenario}`,
        )
        .join('\n\n')
      return parallel(
        [0, 1, 2].map((n) => () =>
          agent(
            `${CONTEXT}\n\n${BASELINE}\n\nYou are skeptic ${n + 1} of 3, judging every claimed defect in one area. Your job is to REFUTE these claims, not to confirm them. Most findings against freshly written code are wrong — the author usually did think of the case.\n\nArea: ${area.name}\nFiles:\n${area.files.map((f) => `- ${REPO}/${f}`).join('\n')}\n\nRead those files in full once, then judge each claim below against what you actually read.\n\nClaims:\n${listing}\n\nFor each one, try hard to show it is wrong: the guard exists elsewhere, the interleaving cannot occur, the type system prevents it, a caller already handles it, the behaviour is intentional and documented, or the "bug" is one of the known deliberate gaps listed above.\n\nReturn one verdict per claim, using the number it was listed under as \`index\`. Answer refuted=true unless you can trace a concrete path through the real code where the failure actually happens. When genuinely uncertain, refute — a false fix to working code is worse than a missed finding.\n\nJudge every claim independently. Do not let a batch of weak claims make you lenient on a strong one, or one real defect make you credulous about its neighbours.`,
            { label: `verify:${key}:${n}`, phase: 'Verify', schema: VERDICTS },
          ),
        ),
      ).then((ballots) => ({ key, batch, ballots: ballots.filter(Boolean) }))
    }),
)

// Three buckets, not two. A skeptic that never ran cast no vote, and counting
// its silence as a refutation is what made the previous run report 136
// "refuted" findings that nobody had read.
const confirmed = []
const refuted = []
const unjudged = []
for (const entry of judgedByArea.filter(Boolean))
  entry.batch.forEach((finding, index) => {
    const cast = entry.ballots
      .map((ballot) => (ballot.verdicts || []).find((v) => v.index === index))
      .filter(Boolean)
    if (cast.length < 2) {
      unjudged.push({ ...finding, votesCast: cast.length })
      return
    }
    if (cast.filter((v) => !v.refuted).length >= 2) confirmed.push(finding)
    else refuted.push(finding)
  })

log(
  `${confirmed.length} survived, ${refuted.length} refuted, ${unjudged.length} never reached a quorum of judges`,
)

// Group confirmed findings by area so each fixer gets a coherent batch.
const byArea = new Map()
for (const finding of confirmed) {
  if (!byArea.has(finding.area)) byArea.set(finding.area, [])
  byArea.get(finding.area).push(finding)
}

phase('Fix')
const fixes = []
// SERIAL on purpose: areas share files (job.ts appears in several), and two
// concurrent fixers would produce a diff belonging to neither.
for (const area of AREAS) {
  const batch = byArea.get(area.key)
  if (!batch || batch.length === 0) continue
  const fix = await agent(
    `${CONTEXT}\n\n${BASELINE}\n\nApply fixes for confirmed defects in one area. These findings already survived three skeptics each, so they are real — but verify each against the code before changing anything, and skip any that does not hold up.\n\nArea: ${area.name}\nFiles: ${area.files.map((f) => `${REPO}/${f}`).join(', ')}\n\nConfirmed findings:\n${batch.map((f, i) => `${i + 1}. [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.title}\n   Failure: ${f.failureScenario}\n   Suggested: ${f.suggestedFix || '(none given)'}`).join('\n\n')}\n\nRules:\n- Minimal fixes. Change what the defect needs and nothing else. No refactoring, no renaming, no style edits.\n- Add or extend a test that FAILS without your fix and passes with it. A fix with no failing test is a fix nobody can trust.\n- Match the surrounding code: Effect-TS idioms, comment density and voice. Comments explain WHY, never what.\n- Do NOT change any durable event shape in packages/schema/src/job-event.ts or any already-applied migration — that breaks replay of existing ledgers. If a finding demands it, skip the finding and say so in your note.\n\nAfter your edits, in this order:\n1. cd ${REPO}/packages/core && ../../node_modules/.bin/tsgo --noEmit\n2. cd ${REPO}/packages/schema && ../../node_modules/.bin/tsgo --noEmit\n3. cd ${REPO}/packages/core && bun test\n4. cd ${REPO} && node_modules/.bin/oxlint <the files you touched>\n\nThe suite must come back to the baseline of exactly those 2 flock failures. If it does not, or typecheck fails and you cannot fix it cleanly, REVERT your changes with git checkout on the files you touched, set reverted=true, and explain. Leaving the tree broken for the next fixer is worse than not fixing.`,
    { label: `fix:${area.key}`, phase: 'Fix', schema: FIX },
  )
  fixes.push({ area, fix, findings: batch })
}

phase('Review')
const applied = fixes.filter((f) => f.fix && f.fix.applied && !f.fix.reverted)
const reviews = await parallel(
  applied.map((entry) => () =>
    agent(
      `${CONTEXT}\n\n${BASELINE}\n\nReview a fix you did not write. Coder and reviewer are deliberately different agents.\n\nArea: ${entry.area.name}\nWhat the fixer says it did: ${entry.fix.summary}\nFiles it changed: ${(entry.fix.filesChanged || []).join(', ')}\n\nThe defects it was fixing:\n${entry.findings.map((f) => `- ${f.title}: ${f.failureScenario}`).join('\n')}\n\nRun \`cd ${REPO} && git diff -- ${(entry.fix.filesChanged || []).join(' ')}\` and read the actual change. Then judge:\n1. Does it actually fix the stated defect, or only make the symptom go away?\n2. Does it introduce anything — a new edge case, a broken invariant, a behaviour change beyond the fix?\n3. Is there a test that would genuinely fail without this change? Check by reading it, and say so plainly if there is not.\n4. Does it violate any of the nine design rules above?\n\nBe concrete. "Looks fine" is not a review.`,
      { label: `review:${entry.area.key}`, phase: 'Review', schema: REVIEW },
    ),
  ),
)

const critic = await agent(
  `${CONTEXT}\n\nYou are the completeness critic for an audit that just ran over these areas: ${AREAS.map((a) => a.name).join(', ')}, each hunted through four lenses (correctness, concurrency, durability/replay, security/escape).\n\nOutcome: ${candidates.length} candidate findings, ${confirmed.length} survived three-skeptic verification, ${refuted.length} refuted, ${unjudged.length} never reached a quorum of judges, ${applied.length} areas received fixes.\n\nFindings that were fixed:\n${confirmed.map((f) => `- [${f.area}] ${f.file}: ${f.title}`).join('\n') || '(none)'}\n\nYour job is to say what this audit MISSED. Look at ${REPO} and consider: a file in the subsystem that no area covered; a failure mode none of the four lenses would catch; an invariant from the nine design rules that no finding touched; an interaction BETWEEN areas that a per-area hunt structurally cannot see. Be specific and name files. Do not restate what was found.`,
  { label: 'completeness', phase: 'Review' },
)

const brief = (f) => ({ area: f.area, file: f.file, title: f.title, severity: f.severity })

return {
  candidates: candidates.length,
  lowDropped: dropped,
  overCap: capped,
  confirmed: confirmed.map(brief),
  refuted: refuted.map(brief),
  // Reported separately and never sent to a fixer: a finding nobody read is
  // not a finding that was rejected, and conflating the two is how a run that
  // died of session limits reports itself as a clean audit.
  unjudged: unjudged.map((f) => ({ ...brief(f), votesCast: f.votesCast })),
  fixes: fixes.map((f) => ({ area: f.area.key, ...f.fix })),
  reviews: reviews.filter(Boolean),
  gaps: critic,
}
