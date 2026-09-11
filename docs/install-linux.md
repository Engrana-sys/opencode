# Installing this fork on Linux

This builds and runs the fork from source. It is not the upstream installer:
`curl -fsSL https://opencode.ai/install | bash` fetches a prebuilt binary of
upstream opencode and knows nothing about the job harness added here.

Tested against Debian 13 and CachyOS. Anything else with a recent glibc and Bun
should work the same way.

## What you need

| Requirement | Why | Notes |
| --- | --- | --- |
| **Bun 1.3.14+** | The whole repo runs on it — package manager, test runner and TypeScript runtime | The version is pinned in the root `package.json` as `packageManager` |
| **git** | Source, and the harness creates git worktrees per writing worker | 2.30 or newer |
| **curl**, **unzip** | Only to install Bun itself | |
| **ripgrep** | Used by the search tools | Optional: if `rg` is not on `PATH`, opencode downloads its own copy (15.1.0) into its cache on first use |

No Node.js is required. No system compiler is required either — `node-pty` ships
prebuilt binaries, and the repo's `postinstall` only fixes their file
permissions.

## Install Bun

The official installer works on every distribution and is what the pinned
version expects:

```bash
curl -fsSL https://bun.sh/install | bash
```

It installs to `~/.bun` and adds it to your shell profile. Open a new shell, or:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

Check it:

```bash
bun --version
```

If your distribution packages Bun, that works too — just make sure it is at
least the version pinned in `package.json`. An older Bun fails in confusing
ways rather than refusing to start.

### System packages

Debian / Ubuntu:

```bash
sudo apt install git curl unzip ripgrep
```

Arch / CachyOS:

```bash
sudo pacman -S git curl unzip ripgrep
```

## Get the source and install dependencies

```bash
git clone https://github.com/Engrana-sys/opencode
cd opencode
bun install
```

`bun install` pulls a large workspace — the repo is a monorepo with around
thirty packages. Expect a few minutes on a first run.

**If `bun install` hangs or fails on `ghostty-web`:** that dependency belongs to
`packages/app` (the web UI) and is fetched straight from GitHub, so it fails
behind a proxy or firewall that blocks `api.github.com`. Nothing in the CLI, the
harness or the tests needs it. Remove the line from `packages/app/package.json`
and install again if you are not working on the web UI.

## Run it

From the repo root:

```bash
bun run dev
```

That is `bun run --cwd packages/opencode src/index.ts` — the CLI straight from
source, no build step. This is the right way to run it while developing: startup
is a second or two and there is nothing to rebuild after an edit.

## Build a binary

```bash
bun run --cwd packages/opencode build
```

Useful when you want to install the fork onto a machine and stop thinking about
the repo. For everyday work, `bun run dev` is simpler.

## Where it keeps its state

Standard XDG paths, under an `opencode` directory:

| Path | Contents |
| --- | --- |
| `$XDG_DATA_HOME/opencode` (usually `~/.local/share/opencode`) | The SQLite database — sessions, messages, the event ledger, jobs — plus logs, cloned repos and per-worker worktrees |
| `$XDG_CONFIG_HOME/opencode` (usually `~/.config/opencode`) | `opencode.json` and anything else you configure |
| `$XDG_CACHE_HOME/opencode` (usually `~/.cache/opencode`) | Downloaded binaries such as ripgrep |

The database migrates itself on startup. Nothing to run by hand.

**Backing up means copying the data directory.** Everything durable lives
there: the event ledger is the historical record of every job, and the
projections are rebuilt from it.

## Verify the install

```bash
cd packages/core && bun test
```

Expect **`1242 pass / 2 fail`**. The two failures are
`util.flock > fails clearly on unwritable lock roots` and
`util.effect-flock > fails on unwritable lock roots`. They fail **only when the
suite runs as root**, because the test creates an unwritable directory and
expects a permission error — and root can write anywhere. Running as an ordinary
user, all 1244 pass.

Type checking, from the repo root:

```bash
bun turbo typecheck
```

Linting:

```bash
node_modules/.bin/oxlint
```

## Configure a provider

The harness needs at least one model provider before it does anything
interesting. Configuration lives in `~/.config/opencode/opencode.json`; run
`bun run dev` and use `/models` to connect one interactively.

For the fork's own settings — persistent goals, loops and the system-model
chains — see [`goals-and-loops.md`](./goals-and-loops.md).

## Updating from upstream

This fork tracks `sst/opencode`. To pull in upstream work:

```bash
git remote add upstream https://github.com/sst/opencode   # once
git fetch upstream dev
git merge upstream/dev
bun install                                               # lockfile may have moved
cd packages/core && bun test
```

Conflicts concentrate in `packages/core/src/location-services.ts`,
`packages/server/src/routes.ts` and `packages/schema/src/event-manifest.ts` —
the three registries the fork adds entries to. They are additive lists, so
conflicts there are almost always "keep both sides".
