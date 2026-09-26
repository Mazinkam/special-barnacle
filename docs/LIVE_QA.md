# Phase 3 — Forge live-QA verification stage

Opt-in bridge stage that lets `/orchestrate` hand the candidate's actual changes to an
**existing** Forge live-QA runner (`bun qa run focused ...`) as an additional, additive
verification signal — on top of, never instead of, the orchestrator's own generic QA gate. It is
off by default; nothing about an ordinary run changes unless you explicitly ask for it.

Implementation: `bridge/extensions/orchestrator/live-qa.ts` (config, adapter selection primitives,
scope validation, tested-revision proof, spawn, session parsing, cost rows, outcome row) and
`bridge/extensions/orchestrator/live-qa-stage.ts` (the single call `index.ts`'s `/orchestrate`
handler makes to run all of that once per run).

## Trust model

- The adapter config is read **only** from the path named by the
  `HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG` environment variable, which **must be an absolute path** —
  a relative one is rejected as a config error (live QA reports unconfigured/unavailable) rather
  than being resolved against whatever the current process's working directory happens to be at
  read time. If the variable is unset, live QA is unconfigured — full stop. Nothing is ever
  discovered from the repository under test (no `.forge-qa.json`, no convention-based path, no
  fallback location).
- Every adapter entry must set `"trusted": true` literally, or it is disabled. This is a
  config-authoring gate, not a security boundary by itself — treat the config file itself as a
  secret you control, since it names an `argv_prefix` that will be spawned with the parent's full
  environment.
- `argv_prefix` elements are validated to reject `NAME=value` env-style assignments and anything
  that looks credential-shaped (`token`/`secret`/`password`/`api[_-]?key`/`bearer`, case
  insensitive). This closes an obvious authoring mistake; it does not make an untrusted config
  safe to load.
- The runner is always spawned as `argv[0]` + args (`shell: false`) — never through a shell
  string. The user-authored `scope` text is passed as exactly one argv element, so shell
  metacharacters inside it are inert.
- Runner stdout/stderr is redacted (env-credential-shaped values, `Bearer <token>`, URL userinfo
  of any length) before it ever reaches the session log or the diagnostic tail. Env values
  themselves are never logged by any part of this stage. A single output line that grows beyond
  64KiB without a newline is discarded outright (never emitted as a fragment, redacted or not — a
  secret can straddle exactly that boundary) and reported only as a byte-count marker line; normal
  per-line parsing resumes once the next newline arrives.
- Everything `runLiveQaStage` returns — the outcome row, cost rows, reasons, and
  `runtime_under_test` (including `runner_cwd` and the adapter id) — is passed through the same
  redaction (`sanitizeForPersistence`) before being returned, on every return path, including a
  preflight/config/scope/revision failure that never spawned a runner at all: a credential that
  ends up embedded in a config path or a `runner_cwd` is redacted exactly like runner output is.

## Config schema (v1)

Read by `loadLiveQaConfig(env)` / `parseLiveQaConfig(raw)` in `live-qa.ts`. Top level:

```jsonc
{
  "version": 1,          // required, must be literally 1
  "adapters": [ /* LiveQaAdapterConfig, see below */ ]
}
```

Any other top-level key rejects the **whole** config (not just the offending key) — a typo'd or
unrecognized key at this level most often signals a schema mismatch, and proceeding with a
partially-understood config is the wrong default for something that spawns real processes.

Each entry in `adapters`:

| field | type | validation |
|---|---|---|
| `id` | string | `^[a-z0-9-]{1,40}$` |
| `kind` | string | must be `"forge-qa"` |
| `trusted` | boolean | must be literally `true` |
| `runner_cwd` | string | absolute path (Forge's `repoRoot`) |
| `argv_prefix` | string[] | non-empty; no empty strings, NUL, newline, `=`, or credential-shaped words |
| `flow` | string | must be `"focused"` (the only flow this adapter supports) |
| `slot` | `0 \| 1` | optional; omit to use Forge's own default |
| `budget_minutes` | integer | `1..240` |
| `runtime` | string | `codex \| humain-terminal \| claude-code` |
| `model` | string | a valid **alias** for `runtime`, per Forge's own `scripts/qa/cli.ts` alias tables (`MODELS`, `HUMAIN_NODE_MODELS`, `CLAUDE_CODE_MODELS`) — never the resolved model slug, and never an alias valid for a different runtime |
| `effort` | string | `low \| medium \| high \| xhigh` |
| `local` | boolean | must be literally `true` (this adapter never publishes to GitLab) |
| `required` | boolean | optional, defaults to `true`; whether an unavailable stage fails the run's live-QA verdict |

An unknown key inside one adapter entry disables **only** that adapter (with a problem), unlike an
unknown top-level key. See `docs/examples/live-qa.example.json` for a complete, valid example
(placeholder `runner_cwd` — not loaded automatically by anything).

## Adapter selection

`/orchestrate` selects at most one adapter per run:

- `--live-qa-adapter <id>` given: that id must match a valid adapter, or the stage is
  `unavailable` (`unknown live-QA adapter id "<id>"`).
- No id given, exactly one valid adapter configured: it is selected automatically.
- No id given, more than one valid adapter configured: `unavailable` (`ambiguous: N valid live-QA
  adapters configured ...; specify --live-qa-adapter <id>`).
- Zero valid adapters (unconfigured, or every entry disabled by a problem): `unavailable` (`no
  valid live-QA adapter is configured`).

## Usage

```
/orchestrate --live-qa --live-qa-scope "verify the login flow end to end" Fix the login race
/orchestrate --live-qa-adapter forge-focused --live-qa-scope "checkout flow" <goal>
```

- `--live-qa` — explicit boolean request.
- `--live-qa-scope "<text>"` — the free-text scope handed to Forge's `run focused <scope>`. May be
  a double-quoted, multi-word value; also **implies** the request (`--live-qa-scope` alone is
  enough — you do not need `--live-qa` too). An unterminated quote is reported as an unknown flag,
  never silently truncated or accepted.
- `--live-qa-adapter <id>` — select a specific configured adapter by id.
- `--no-live-qa` — explicit off. **Always wins**, regardless of flag order, over `--live-qa` and
  `--live-qa-scope`.
- No live-QA flags at all: the stage never runs. Nothing about an ordinary run's behaviour,
  verdict, cost, or summary changes.

Flags are honored only in the leading/trailing flag block around the goal, exactly like every
other `/orchestrate` flag — a `--live-qa` mentioned mid-goal is prose, not a flag.

## When the stage runs

At most once per run, and only when **all** of the following hold:

1. `--live-qa` (or `--live-qa-scope`) was given, and `--no-live-qa` was not.
2. The run was not blocked (no lead stopped at a precondition).
3. Dispatch succeeded (at least one lead exited 0).
4. The orchestrator's own generic QA gate **passed**.

If (2)-(4) fail, live QA is recorded as **not run**, with the specific reason, and the runner is
never spawned. Live QA never runs against a candidate whose generic verification already failed,
was skipped, or never happened.

Every precondition failure *inside* the stage itself — no config, config present but no valid
adapter, ambiguous/unknown adapter id, missing/invalid scope, or a failed tested-revision proof —
resolves to `unavailable`, **never** `pass`, and the runner is never spawned either.

## Tested-revision checkpoint

> **The Forge checkout named by `runner_cwd` MUST share a git object store with the candidate
> repository** (the same repo, or a linked worktree of it — i.e. `git rev-parse
> --git-common-dir`, realpath'd, must be identical for both). If it does not — a separate clone, a
> stale mirror, an unrelated checkout of the same project — the tested-revision proof
> (`prepareTestedRevision`) returns `unavailable`, never a silent fallback to the runner's own
> `HEAD`/`main`. This is the single most common reason live QA reports `unavailable` in a fresh
> environment: point `runner_cwd` at a worktree of the SAME repository being orchestrated, not a
> separately-cloned copy of it, even if that copy happens to be up to date content-wise.

Proven, not assumed: `prepareTestedRevision` proves the runner's own checkout can resolve the
exact SHA that will be tested and that its file content matches the candidate's changed files. A
clean `HEAD` is used directly. A dirty working tree is captured with a **local checkpoint commit**
that never touches your real index, `HEAD`, or branch (a temporary `GIT_INDEX_FILE` seeded from
`HEAD`, built entry-by-entry via `git hash-object --no-filters -w` + `git update-index --add
--cacheinfo` — deliberately never a plain `git add -A`, which cannot be told to skip a
repo-controlled `.gitattributes` clean filter — `write-tree`, `commit-tree -p HEAD`), protected
from GC under its own, CREATE-ONLY ref (checked with `git symbolic-ref -q`/`git show-ref --verify
-q` before creation — catching even a DANGLING pre-existing symbolic ref that `update-ref
--no-deref`'s own old-value check alone would not — then created via `git update-ref --no-deref`,
refusing to move or overwrite anything already at that path):

```
refs/orchestrator/live-qa/<runId>
```

**"The candidate's changed files" is the CANDIDATE-OWNED set, never the broad dirty-file
detection set.** `/orchestrate`'s own generic QA gate scopes itself to `allFiles` — every path git
shows as changed since the run began, by ANY means (a committed diff, a dirty-snapshot diff, a
prose fallback) — but the live-QA checkpoint's `changedFiles` input is deliberately narrower:
only the paths THIS run's own leads/implementers themselves claimed changing
(`filesChanged`/`candidateOwnedFilesForLiveQa`, index.ts), via the same Phase 2 file-ownership/
changed-file reporting the rest of the run already relies on. A file git shows as dirty that
nobody in this run claimed touching — a concurrent process's own scratch file, a stray `.env`
someone else dropped into the working tree — is therefore never represented in the checkpoint
tree at all, EXCLUDED from evidence (never merely redacted or hashed-but-hidden), even though
`buildCheckpointIndex` would happily checkpoint anything it is told to. If NO candidate-owned file
can be established at all (no lead/implementer claimed changing anything) while the working tree
is still dirty, `prepareTestedRevision` refuses to guess: it fails closed with "candidate working
tree is dirty but no candidate changed-file set was provided," which resolves to live QA
`unavailable` — never a silent checkpoint of "everything dirty," and never a pass.

Every git invocation this checkpoint makes runs with hardened config (`core.fsmonitor=false`,
`core.hooksPath=/dev/null`, `core.untrackedCache=false`, `core.attributesFile=/dev/null`,
`-c protocol.allow=never`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_NO_LAZY_FETCH=1`,
`GIT_TERMINAL_PROMPT=0`) plus a **filter DRIVER config guard** (authoritative) and a
**repository-wide** `git check-attr` pre-flight (defense in depth), so a candidate whose working
tree carries a malicious `.git/hooks/*` script, a `core.fsmonitor` command, a
`.gitattributes`-registered `filter` driver on ANY path git can see (tracked or untracked, not
merely the reported changed files), or a partial-clone/promisor remote configured to lazily fetch
a missing object over an attacker-controlled transport cannot have any of those executed by this
stage — the checkpoint fails closed (`unavailable`) instead:

- **Filter DRIVER config guard (authoritative).** A git content filter is a two-part mechanism: an
  ATTRIBUTE (`.gitattributes`, itself repo-controlled content) that merely NAMES a driver, and a
  CONFIG ENTRY (`filter.<name>.clean`/`.smudge`/`.process`) that supplies the command git actually
  runs for that name. Naming a driver with no matching config entry is a no-op — the EXECUTABLE
  half of this mechanism is always the config, never the attribute value. Before any
  filter-capable git operation (an earlier, purely informational `git rev-parse --git-common-dir`
  call runs first, but that call is metadata-only and can never invoke a content filter),
  `git config -z --show-scope --get-regexp '^filter\.'` (a pure read; it executes nothing) is
  checked for any entry whose scope is `local` or `worktree` — i.e. defined in `.git/config`/
  `.git/config.worktree`, **including** a value pulled in transitively via an
  `include.path`/`includeIf.<cond>.path` directive written in the local config (git attributes the
  scope of an included entry to the scope of the file that did the including, so a `.git/config`
  `[include] path = /anywhere` line pointing at a file that defines `filter.x.clean` still reports
  scope `local`). `-z` (NUL-delimited output) is essential here: a config VALUE can itself contain
  an embedded, literal newline (e.g. a multi-line `filter.<name>.process` command), and only the
  NUL byte — never `\n` — is guaranteed not to appear inside a value, so it is the only delimiter
  that unambiguously marks a record boundary; output this parser cannot confidently interpret
  fails closed (refused) rather than being treated as "no entries". If any such entry exists, the
  checkpoint is refused with: *"repository-local git config defines filter drivers; refusing
  checkpoint to avoid executing repository-controlled commands"* — **before** the check-attr
  preflight below, and before the very first `git status` call, or any other filter-capable git
  operation, ever runs. `global`/`system`/`command` scope drivers (an operator's own
  `~/.gitconfig` git-lfs installation, or this module's own `-c` flags) are operator-trusted and
  always allowed; a repository with only a global filter driver checkpoints normally.
- **Filter-attribute preflight (defense in depth only).** `git check-attr`'s text output cannot
  distinguish an attribute explicitly assigned the literal string `"false"`/`"unset"`/
  `"unspecified"` (`path filter=false`) from the corresponding boolean/negation keyword forms
  (`-filter`/`!filter`/no mention at all) that print identically — so this layer cannot, by itself,
  tell a real "no filter" from an attacker naming a driver "false"/"unset"/"unspecified" to evade a
  naive value allow-list. It therefore treats **anything other than the literal text
  `"unspecified"`** as unsafe and refuses, and it is never the control that decides whether a
  filter can actually run — that is decided entirely by the driver-config guard above. Kept as
  defense in depth, and extended to close a second gap: it enumerates every path git can see —
  `git ls-files -z` (tracked), `git ls-files -z --others --exclude-standard` (untracked-but-not-
  ignored), **and** `git ls-tree -r -z --name-only HEAD` (every path in HEAD's tree, regardless of
  index state) — the last of these covers a file `git rm --cached` removed from the index and
  whose path was then also `.gitignore`d: invisible to both `ls-files` calls, yet still restored
  into the checkpoint's temporary index by `git read-tree HEAD` later. `check-attr` only ever
  answers an attribute LOOKUP; it never runs a filter or reads blob content.
- **No network (S1b).** `-c protocol.allow=never` plus `GIT_NO_LAZY_FETCH=1` independently block a
  partial-clone/promisor-configured repository (`remote.origin.promisor`,
  `extensions.partialClone`) from lazily fetching a missing object — and therefore from ever
  invoking an attacker-controlled `core.sshCommand`/transport — as a side effect of an ordinary
  read like `git cat-file -e`. `GIT_TERMINAL_PROMPT=0` guarantees no call ever blocks waiting on a
  credential prompt either. A missing object fails closed (`unavailable`); it is never fetched.

If the runner's checkout cannot resolve that SHA (a stale clone, a different repository entirely),
the stage is `unavailable` — never silently falls back to the runner's own `HEAD`/`main`, which
would test the wrong tree.

## Ancestor-directory trust for session artifact reads (residual TOCTOU risk)

Every artifact read (`report.md`, `findings.json`, `usage.json`, `results.md`) is confinement- and
freshness-checked (`checkConfined`/`readConfinedArtifact`: `lstat` + `O_NOFOLLOW` at open time +
`fstat` dev/ino re-check against the earlier `lstat`, closing the TOCTOU window for the file's OWN
path). That still leaves one window plain Node cannot close: **Node has no
`openat2(RESOLVE_NO_SYMLINKS)`/`O_BENEATH` equivalent**, so there is no way to atomically bind "the
path I just confirmed is safe" to "the path I am about to open" across every ANCESTOR directory
the way `O_NOFOLLOW` does for the artifact's own final path component. Between
`checkConfined`'s `realpathSync` and the eventual `openSync`/`readSync`, an ancestor directory
anywhere between the session directory and the FILESYSTEM ROOT could in principle be removed and
replaced with a symlink by a concurrent process.

`verifyTrustedAncestry` (live-qa.ts) bounds this risk instead of eliminating it, immediately
before any artifact under the session directory is read. **An earlier version of this check
stopped walking at (and including) `runner_cwd`** (the adapter's configured trusted root) — which
left a real gap: the PARENT of `runner_cwd`, and everything above it, was never inspected at all,
so a *different* uid with write access to `runner_cwd`'s parent could rename/replace the whole
`runner_cwd` tree (session directories and all) between the confinement check and the artifact
read, entirely above the directory this check used to stop at. The current version walks every
ancestor directory from the session directory all the way up to the **filesystem root `/`**, and
each one must (a) contain no symlink, and either:

- be owned by this process's own uid (`process.getuid()`) or by uid 0 (root), **and** be writable
  by no one else (`mode & 0o022 === 0` — neither group- nor world-writable); or
- be owned by uid 0 (root) **and** have the sticky bit set (`mode & 0o1000`, e.g. `/tmp`,
  `/private/tmp`, mode `1777`) — in which case the directory immediately BELOW it in the chain
  must itself already be confirmed owned by this process's own uid or root (the sticky bit
  protects entries INSIDE a directory from being renamed by another uid; it says nothing about the
  directory itself, so this alternative only accepts a sticky, root-owned directory whose child in
  the chain was already trusted on its own merits).

Any failure here means the session's artifacts are treated as **unreadable evidence** — the
verdict is `unavailable` (UNVERIFIED), never `pass`. `process.getuid` being unavailable at all
(e.g. Windows) also fails closed, for the same reason.

**Why this is an acceptable bound, not a full fix:** only a process already running as the SAME
uid as this orchestrator process (or root) could perform the ancestor-swap race this check cannot
fully close. Such a process already holds every privilege this orchestrator process holds — it
gains nothing from this specific race that it could not already do directly (read this process's
own memory, ptrace it, write to any file this uid can write). The residual risk is therefore "no
privilege escalation beyond what an equally-privileged process already has," which is the
strongest guarantee achievable without a kernel primitive Node does not expose.

**Operational note — umask matters here.** This check assumes ordinary directory-creation
hygiene (umask `022` or stricter), under which `mkdir`-created directories end up `0755`/`0700`
and pass cleanly. If Forge's real session directories (or any ancestor between the session
directory and the filesystem root) are created under a more permissive umask (e.g. `002`, common on some shared/group-collaborative
dev setups), they may end up group-writable (`0775`) and this check will correctly reject them —
live QA will report `unavailable` until the environment's umask/ownership is tightened. This is
**intentional fail-closed behaviour, not a bug to route around**: weakening the check to
accommodate a permissive umask would silently reopen the exact TOCTOU window it exists to bound.

## Session verdict: results.md is authoritative, not just findings.json

Forge's own prompt contract (`scripts/qa/prompts/common.md` item 3) requires the QA agent to write
`results.md` as a Markdown table with a `Result` column whose values are exactly
`PASS`/`FAIL`/`BLOCKED` — mirroring Forge's own readiness check (`cli.ts` ~425-430: at least one
`| PASS |` row and no `FAIL`/`BLOCKED` row for GO). `parseLiveQaSession` enforces the same
contract on the orchestrator side:

- `results.md` missing, unparseable, or with no recognized result rows: `unavailable`.
- Any `FAIL` row: `fail`, even with clean `findings.json` and a `0` exit code.
- Any `BLOCKED` row (with no `FAIL`): `unavailable` — a blocked run is unverified, never a pass.
- Only when every row is `PASS`, `findings.json` has no confirmed tier 1/2 finding, AND the runner
  exited `0`: `pass`.

`results.md` is held to the same symlink-confinement and freshness (mtime) checks as every other
session artifact.

## Verdict semantics

The generic QA gate's own `verification: <verdict>` line and `passedVerification` boolean are
composed with the live-QA outcome (pure logic in `composeVerificationVerdict`, index.ts):

| live QA | required | result |
|---|---|---|
| not requested / not run | — | generic verdict/boolean unchanged |
| `fail` (confirmed tier 1/2 finding) | any | `FAIL (live QA: <reasons>)`, `passedVerification: false` |
| `unavailable` | `true` | `UNVERIFIED (required live QA unavailable: <reason>)`, `passedVerification: false` |
| `unavailable` | `false` | generic verdict kept, `; live QA unavailable (not required)` appended, boolean unchanged |
| `pass` | any | `PASS (+ live QA pass, session <id>)`, boolean unchanged (already `true`) |

Live QA is never escalated or retried on failure — a live-QA `fail`/`unavailable` is recorded, not
re-dispatched.

A dedicated `live QA: ...` summary line reports the verdict, tested revision (short SHA), Forge's
own session id, and artifact paths (or `not run (<reason>)`), plus a `live-QA cost unknown` line
whenever any of its cost rows carry an unmeasured `cost_source`. `completeRun`'s summary also
carries a structured `live_qa` object with the same facts for programmatic consumers.

## Forge prerequisites

This adapter invokes Forge's **existing** `bun qa run focused ...` CLI — it never invents Forge
flags or a new QA surface. Everything the runner itself needs is Forge's responsibility, not
this adapter's:

- Docker running, with the `forge-qa-browser` image available.
- A configured `.env` / `DATABASE_URL` for the app under test.
- Runtime auth for whichever `runtime`/`model` the adapter is configured with (Codex, HUMAIN
  Terminal, or Claude Code credentials, as applicable).
- `nuclei` available on the runner's `PATH` (Forge's own security-scan step).
- `slot` left unset unless you need to pin one — Forge applies its own default.

Budget (`budget_minutes`), cancellation, and artifact cleanup are entirely Forge's own concern:
this adapter passes `--budget` through and, on cancellation, sends the runner exactly one `SIGINT`
and waits for its real exit — it never times out on its own and never runs `bun qa clean`.

## Limitation: the orchestrator extension is never exercised

Forge runs HUMAIN Terminal with `--no-extensions --extension <its own>` for the QA agent's own
session. This orchestrator extension is therefore **never loaded inside the runner it spawns** —
a live-QA pass proves the application under test works from the outside, never that this
extension's own code executes correctly. **An orchestrator-extension smoke test is NOT
established by this integration** — a live-QA `pass` says nothing whatsoever about whether this
extension itself is healthy, only about the application it tested. Every outcome row records this
unconditionally as `orchestrator_extension_exercised: false`, and `runtime_under_test` records the
runner's own runtime/model/effort/cwd/HEAD alongside it for the record.

## Expected side effects from Forge's own focused (discovery) flow

Forge's `run focused` flow is a real, autonomous QA agent — running it has real, EXPECTED side
effects beyond the session artifacts this adapter reads:

- **Confirmed findings may be filed via Forge's own `fileFindings`.** A tier 1/2 confirmed finding
  is not merely reported in `findings.json` — Forge's own agent may file it through its own
  findings pipeline as part of the same run. This is Forge's normal behaviour for its `focused`
  flow, not something this adapter triggers, controls, or can suppress; expect real findings to
  appear wherever Forge normally files them, on any run whose QA agent confirms one.
- **A slot environment may be retained via `retainEnvironment`/`--keep`.** When the QA agent (or a
  human/CI operator) requests environment retention (a finding's `retainEnvironment` field, or a
  `--keep` flag Forge itself may apply), Forge keeps that slot's environment running/allocated
  past the end of THIS invocation, for later inspection. This adapter never passes `--keep` itself
  and never requests retention — but it does not prevent Forge's own agent from doing so, and does
  not clean up a retained environment on your behalf. A retained slot is Forge's own resource;
  release it the same way you would after running Forge directly.

## Cost attribution

Two possible cost rows per session, stable-keyed by Forge's own session id so re-delivery is
deduplicated by `record_id`, never double-counted:

- `record_id: live-qa-agent:<session>` — the QA agent's own usage (from Forge's `usage.json`).
  `cost_usd` is present only when Forge reported (or estimated) it; otherwise it is **absent**
  (never `0`) and `cost_source` starts with `unknown-`. An unknown number, when Forge's own
  `usage.json` still supplied one, is kept ONLY as a non-billable `unattributed_cost_usd_hint`,
  never as `cost_usd`. When `session_id` is missing entirely, the row key falls back to
  `<runId>:<adapterId>:no-session` — unique per run/adapter, never a shared `:unknown` that would
  collide across unrelated runs.
- `record_id: live-qa-app:<session>` — the application-under-test's own runs cost, when Forge's
  `usage.json` reports one.

`totalCost` in the run summary includes only the **known** live-QA cost (rows whose `cost_source`
does not start with `unknown`); an unknown-cost row contributes nothing to it and is called out by
the `live-QA cost unknown` summary line instead of being silently treated as free. On the Python
side, `orchestrator/economics.py::cost_class` classifies every `unknown*` source as `UNMETERED` —
never spend, however `cost_usd` happens to be populated.

## Rollback

Unset `HUMAIN_ORCHESTRATOR_LIVE_QA_CONFIG`. With it unset, `--live-qa`/`--live-qa-scope` still
parse but the stage is always `unavailable` (`no valid live-QA adapter is configured`) and the
runner is never spawned; omitting the flags entirely returns to byte-identical baseline behaviour.
