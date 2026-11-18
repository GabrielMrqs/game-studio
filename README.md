# AI Game Studio

The [GitHub-first watcher](studio/GITHUB_FIRST.md) consumes Ready Linear issues
and publishes validated work as GitHub PRs. It repairs game test failures,
merges once GitHub's required checks pass, and records the verified merge in Linear.
The local `studio/develop` runner and Cezar workflows below are legacy tools;
do not run them alongside the GitHub-first watcher.

This is an early prototype, not the complete autonomous studio. Cezar 0.20.0 is
pinned in `package-lock.json`; see [AUDIT.md](AUDIT.md) for the choice and risks.
The local inbox submits ideas to Cezar's `studio-plan` workflow, which asks
OpenCode for a plan by default. Cezar owns the queue and worktrees. An opt-in
feature workflow and explicitly approved draft-PR command are experimental.
A small playable Godot prototype is included;
Linear ingestion is experimental and has not been tested against a live workspace.

An isolated **mock-only** Docker Compose preview is documented in
[`OPERATIONS.md`](OPERATIONS.md). It is not a safe real-agent deployment.

## Turn one idea into a local gameplay commit

Place one new `.md` file in `ideas/`. Save local settings once in the ignored
`.studio-state/once.json`. These are the defaults (use absolute paths or paths
relative to the repository; replace `/home/you` with your home path):

```json
{
  "opencodeHome": "/home/you/.local/share/game-studio/opencode",
  "godot": "/usr/bin/godot",
  "xvfb": "/usr/bin/Xvfb",
  "workspaceDir": ".studio-state",
  "logsDir": ".studio-state"
}
```

Create `studio/develop` locally from a validated game commit if it does not
already exist. Keep it unchecked out; use a detached worktree to play it.
Use a dedicated, private OpenCode profile already signed in. Never point it at
your normal home or copy that home's credential database. Requires Linux,
Bubblewrap, GNU `timeout`, `flock`, OpenCode 2.3 at `/usr/bin/opencode`, Godot
4.3, Xvfb, ImageMagick (`convert`), and Mesa software OpenGL (on Arch:
`xorg-server-xvfb`, `imagemagick`, and `mesa`). Graphical validation needs
Bubblewrap with nested user namespace support (`--disable-userns`).

```sh
npm run studio:once
```

OpenCode can edit or add regular, non-executable Godot scripts, scenes, text
resources, shaders, images and fonts under `game/`. A single file is enough.
It cannot change project settings, generated metadata or caches, or the preview
harness. `game/CASE_01_AURORA.md` remains add-only. Path, file type and Git index
checks reject everything else before validation.

The agent has a four-minute limit and uses its existing sandbox profile. Godot
has a 90-second import/startup/smoke budget, followed by separate bounded preview
and screenshot verification steps. Validation uses a copy from the staged Git
tree, without network, credentials, the host display, or worktree access. The
watcher expects the main-menu flow on `studio/develop`. Each run keeps separate
logs and, on graphical success, real 960×640 menu and gameplay screenshots in
`screenshots/`. The capture process reads the private Xvfb framebuffer; the
candidate can draw to that display but cannot see the framebuffer file or write
the evidence directory. There is no unsandboxed fallback.
Idea contents are claimed once in local Git under `refs/studio/ideas/`: renaming
an idea doesn't requeue it. Failed or interrupted claims stay blocked for manual
review rather than automatic retry. The command never touches `main` or pushes.

In legacy mode only, use `npm run studio:once -- --watch` to process ideas in filename order,
one at a time, until Ctrl+C. Save complete ideas under another extension and
rename them to `.md` when ready. Both commands share a repository lock. Each
feature starts from the current `studio/develop` tip. If the tip changes during
a run, the feature is preserved and processing stops without integrating it.
If a run fails after claiming an idea, review its receipt, logs and worktree
before clearing the gate with `git update-ref -d refs/studio/active`. Leave the
idea receipt in place to prevent replay.

For a timed-out Linear run with a confirmed In Progress write and no later
writeback, keep the gate and receipt in place. Back up the partial files, then
finish one small, runnable checkpoint in the existing worktree. From
`studio/local`, run `npm run studio:once -- --recovery-preview once-XXXXXX`.
This uses the same path checks, Godot tests and graphical QA with a temporary
index. It does not launch an agent, commit, integrate or write to Linear.
Exit 2 and `preview-*/checkpoint.json` mean the checkpoint is ready for human
inspection, not approval to integrate. Review before extending the work; for
multi-room art, capture and review before/after evidence for each required room.

### Visual review

Changes to game code or assets can affect presentation, so the runner stops with
`REVIEW REQUIRED` (exit 2) after automated checks pass. The tested commit and
`visual-review.json` remain available; `studio/develop` and the claim stay at the
base, and a Linear issue stays **In Progress**. The story note alone does not
require this gate. Look at both screenshots and check layout, legibility and
interaction in a detached playtest if needed; nonblank PNGs do not prove quality.

To approve, stop polling and read `base`, `receipt`, `commit` and `tree` from
`visual-review.json`. Confirm `studio/develop` is not checked out and
`git show -s --format='%P %T' "$commit"` matches `"$base $tree"`. With those
verified values, advance only the tested commit and keep the gate until any
Linear reconciliation is complete:

```sh
printf 'update refs/heads/studio/develop %s %s\nupdate %s %s %s\nupdate refs/studio/active %s %s\n' \
  "$commit" "$base" "$receipt" "$commit" "$base" "$commit" "$base" |
  git update-ref --no-deref --stdin
```

If this succeeds, add the reviewed commit comment in Linear and mark the issue
Done (if applicable), then `git update-ref --no-deref -d refs/studio/active "$commit"`.
If any ref changed or a Linear update failed, stop and reconcile before resuming.
To reject, leave `studio/develop` unchanged and keep the receipt; record the
decision in Linear if applicable, then clear the matching gate at `"$base"`.

Deploying runner changes requires restarting `game-studio.service` so it loads
the new code. Verify Xvfb and ImageMagick are available and wait until the watcher is idle (no
`refs/studio/active` claim or in-flight work) before restarting it.

### Optional Linear polling

1. Create a personal API key with access to read issues, update statuses, and
   create comments for the chosen team. Save only the key, outside Git:

   ```sh
   install -d -m 0700 ~/.config/game-studio
   read -rs LINEAR_KEY
   (umask 077; printf '%s\n' "$LINEAR_KEY" > ~/.config/game-studio/linear.key)
   chmod 600 ~/.config/game-studio/linear.key
   unset LINEAR_KEY
   ```

2. Add a `linear` object to `.studio-state/once.json`. Use Linear model UUIDs
   for `teamId`, `labelId`, `readyId`, `inProgressId`, `doneId`, and optionally
   `projectId`. The three statuses must belong to the chosen team. Set
   `pollSeconds` if needed (default 60; minimum 15).
3. For a supervised demo, stop any active `game-studio.service`. Put exactly one
   issue in Ready with the dedicated label, leave no unclaimed local ideas,
   and run `npm run studio:once`. Check the issue for Done and the commit
   comment. To poll in legacy mode only, run `npm run studio:once -- --watch`.

Local ideas take priority. The Linear issue UUID is claimed in Git before any
mutation; the review gate stays set until Linear confirms the comment and Done.
If a write fails or is interrupted, review the issue and its `linear.log` before
clearing the gate. A local commit can already be integrated even if the Linear
writeback failed. Never delete the issue receipt to retry writeback.

For deployment of the current systemd unit, see the
[GitHub-first migration runbook](studio/GITHUB_FIRST.md).

## Status

Run `npm run status` from the repository root to print JSON counts for local
inbox receipts, Linear handoffs, publication phases, watchdog cancellations and
Cezar run states. It also lists valid Cezar run IDs, their state and workflow.
For an active run, `warning: "unrecorded_worktree"` means the standard worktree
exists on disk but Cezar's run record does not contain its path. Investigate
before resuming; the command never repairs or deletes worktrees.
The base mock Compose worker also checks persisted run metadata before starting
Cezar and refuses uncertain recovery; see `OPERATIONS.md` for scope and recovery
limitations.

For a stopped project, `npm run inspect-recovery -- RUN_ID` reports the
persisted run, recorded session IDs, worktree registration and matching inbox
receipts without starting Cezar or modifying state. See `OPERATIONS.md` for
writer-stop requirements and the information it cannot verify.
`STUDIO_STATE`, `STUDIO_INBOX` and `CEZ_API_URL` must match the worker. The idea
file count includes already processed files; it is not a count of queued runs.
Missing optional state is reported as `missing`; unavailable databases, Cezar,
or a mismatched project identity are reported as `unavailable` with exit code 1.
The command reads databases without modifying receipts and never prints idea
text, run transcripts, paths, tokens, PR URLs or error details. Counts are a
best-effort snapshot across separate stores, not an atomic system-wide view.

## Play the prototype

Open `game/project.godot` in Godot 4.3 and run the project, or run
`godot --path game`. Use the labeled hotspot buttons to explore, talk to the
keeper, collect and select the lens, and use it on the lantern. Save and Load
use a local Godot user-data file. The background is an editable SVG placeholder;
the same artwork currently represents both rooms. This is a standalone slice,
not a Popochiu-based game: Popochiu was evaluated in `AUDIT.md` but has not yet
been integrated or tested.

With Godot 4.3 installed, the shared headless gameplay check is:

```sh
sh studio/test-game.sh
```

For a graphical screenshot of the initial scene, first import as above, then
provide a **new absolute PNG path** on a machine with a graphical display:

```sh
GODOT_BIN=/path/to/godot sh studio/preview-game.sh /absolute/path/to/new-preview.png
```

On Linux with Xvfb, use `xvfb-run -a env GODOT_BIN=/path/to/godot sh
studio/preview-game.sh /absolute/path/to/new-preview.png` for an isolated virtual
display. The script refuses existing output paths and does not load or save game
progress. With `--require-menu`, it captures `main-menu.png` beside the specified
gameplay PNG and checks Continue/Back, intake, pause/resume and return to menu.
Rendering and fonts can differ across systems, so the preview is not a
pixel-identical golden test. To run the graphical test fixtures locally:
`STUDIO_TEST_GRAPHICS=1 node --test studio/preview.test.mjs` (set `GODOT_BIN`
or `XVFB_BIN` to absolute binary paths if not installed in `/usr/bin`).

## Local use

Requires Node 22.13+ (including `node:sqlite`), Git, OpenCode and an authenticated
model. Run only in a dedicated trusted environment: Cezar and OpenCode can execute
commands; Git worktrees are **not** a sandbox. Cezar has no built-in HTTP auth.
Never expose its port publicly or give agents access to valuable credentials.

1. `npm ci --ignore-scripts` installs the pinned Cezar and dependencies.
2. Initialize this project as a Git repository and create an initial commit on
   the intended base branch. This is required for isolated worktrees; the inbox
   requires a committed HEAD. It does not require a clean working tree; changes
   not in the base commit will not be present in the new worktree.
3. In this directory, run `npm run cezar -- --no-open`. Keep the cockpit bound to
   loopback. Confirm OpenCode/model availability in the cockpit.
4. Put an idea in `ideas/example.md`, or JSON `{"idea":"..."}` in `ideas/example.json`.
   Run `npm run inbox`; leave it running to poll. `npm run inbox -- --once` scans once.
   View progress and plans in the Cezar cockpit. Files remain untouched.

The inbox checks the cockpit version and root path before submitting, and uses a
SQLite receipt keyed by the SHA-256 of trimmed idea text to suppress duplicates,
including across restarts and different files. A changed idea is a new submission.
Invalid files are reported and not submitted. Set `CEZ_API_URL` to the cockpit's
loopback HTTP origin, `STUDIO_INBOX` or `STUDIO_STATE` to alternate directories,
and `STUDIO_POLL_SECONDS` to a polling interval (minimum 1; default 30).

## Linear ingestion (experimental)

1. Create a Linear API key with read access limited to the intended team. Set
   `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, and an exact existing `LINEAR_LABEL`
   (for example `studio`) in the process environment. Select the team ID from
   Linear's API; the prototype does not discover it automatically. For example,
   use Linear's GraphQL explorer with `query { teams { nodes { id key name } } }`
   and use the intended team's `id`.
2. In Linear Settings → API → Webhooks, create an Issue webhook scoped to that
   team. Point its HTTPS URL to a TLS reverse proxy that
   forwards only `POST /webhooks/linear` to `127.0.0.1:8787`. Configure the
   webhook's signing secret as `LINEAR_WEBHOOK_SECRET` in the worker environment.
   Linear requires a publicly reachable HTTPS webhook; never expose Cezar's port.
3. Start `npm run linear` alongside `npm run inbox` and Cezar. Environment
   examples are in `.env.example`; they are not automatically loaded. The Linear
   adapter listens on loopback, checks HMAC-SHA256 over the raw body and rejects
   timestamps more than 60 seconds old. Sync the host clock. Every valid Issue
   event wakes a poll; polling also runs at startup and every 60 seconds by
   default (`LINEAR_POLL_SECONDS`, minimum 10).

Polling reads the team's issues through GraphQL, selects backlog/unstarted issues
with the exact label, and publishes each issue ID once as a local idea. Back up
both `.studio-state/linear.sqlite` and `.studio-state/inbox.sqlite` together with
the ideas folder: deleting or separately restoring state can lead to duplicates
or lost handoffs. The first accepted snapshot wins; later edits to that issue do
not start a new run. After an interrupted handoff, an existing regular idea file
is accepted only if it exactly matches its durable receipt. A differing file or
symlink remains untouched and pending, with an error logged; other issues can
continue. Investigate conflicts rather than deleting or overwriting user files.
Descriptions over 60,000 bytes are reported and skipped;
attachments and comments are not ingested. Webhook delivery is a wake-up signal,
not a trusted issue payload. The first page of labels on each issue is checked;
issues with unusually many labels may be missed. This adapter does not update Linear or create PRs.
Ingestion and signing are tested against local HTTP fixtures, not Linear itself.

## Experimental feature workflow

`studio-feature` is an opt-in Cezar graph: producer plan, implementation,
dependency install, tests, separate QA and reviewer sessions, up to two fix attempts,
and a feature-branch commit. A branch check also accepts Cezar's earlier
autosave commit, but rejects an empty or dirty branch. The inbox still selects `studio-plan`, not this
graph. Set `STUDIO_WORKFLOW=studio-feature` on the inbox process to opt in only
in a disposable, supervised, isolated environment. It has not been exercised end to end with real agents;
reviewer independence is a fresh session and an instruction, not a sandbox or
enforced read-only permission. The graph runs the Node suite and the Godot
headless import, startup, and gameplay smoke tests before review. Set
`GODOT_BIN` if `godot` is not on PATH. A missing or failing Godot blocks the
workflow. The graph includes no push, PR, merge, or publish node.
Role instructions and handoff requirements live in [`studio/ROLES.md`](studio/ROLES.md).
Gameplay, narrative/puzzle, and art/UI run in separate sequential sessions
sharing the worktree and handoff; they are not security-isolated agents.

One real `studio-plan` probe completed with OpenCode V2 on a temporary clone and
produced a plan in a feature worktree. Cezar reported `tokensUsed` 119,633 but
15,878 input and 2,319 output tokens; these figures have not been reconciled.
Do not assume reported usage provides an enforceable budget. See
[`OPEN_ISSUES.md`](OPEN_ISSUES.md) before running real workloads.

### Supplementary watchdog

`STUDIO_MAX_RUN_SECONDS=900 STUDIO_MAX_REPORTED_TOKENS=50000 npm run watchdog`
polls Cezar every five seconds for known submitted, provisional, conflicting and quarantined
receipt run IDs, cancelling
active runs over either threshold or with missing usage/timestamps. It stores
cancellation attempts for inbox runs whose standard worktree is present but
missing from Cezar's active run record, after checking the API a second time. A
slow worktree setup can temporarily look the same and be cancelled; inspect
before retrying. This watchdog acts only when it is running and can see both
the receipt and the standard worktree directory. It stores
cancellation attempts in `.studio-state/watchdog.sqlite` and retries uncertain
cancellations; `npm run watchdog -- --once` checks once. `STUDIO_STATE` and
`CEZ_API_URL` must match the inbox. Inspect the log and database for failures.

**This is not a hard deadline or spending cap:** provider calls can overshoot
between checks; Cezar's token and cost reporting may be missing or inconsistent;
cancel requests, the watchdog or the host may fail; and it cannot see runs
created outside this inbox or an unrecorded run after an ambiguous submission.
It does not constrain tokens or dollars at the provider. Do not enable real
unattended agents on the strength of this watchdog. Configure and verify a
provider-enforced spending ceiling, isolation, and independent health/kill
controls before attempting real-mode deployment.

## Publish a reviewed feature (manual, experimental)

Only after reviewing the
worktree, tests and independent review, set `GITHUB_REPO` to `owner/repo`,
`GITHUB_TOKEN` to a token with pull-request write access, and `LINEAR_API_KEY` to a
key with issue-comment write access. Configure Git
credentials separately for pushing `origin`; the GitHub API token is not passed
to Git. Set `STUDIO_STATE` to an absolute persistent directory outside the
worktree and keep it private. After personally reviewing the exact commit, obtain
its full SHA with `git -C /path/to/worktree rev-parse HEAD`. From the studio
repository root, run
`STUDIO_REVIEW_PUBLIC_KEY_FILE=/trusted/reviewer-public.pem node studio/publish-run.mjs RUN_ID --approve REVIEWED_COMMIT_SHA /trusted/review-evidence.json`. The command
requires a durable Linear issue binding made by this inbox, a completed
`studio-feature` run with recorded Godot-check success, QA and review approvals,
and branch-check success,
and a matching worktree branch. The issue ID, base branch and title are taken
from the binding and Cezar run; they are not supplied on the command line.

The evidence file must be JSON `{ "evidence": { "runId": "…", "commit": "…",
"verdict": "approve" }, "signature": "…" }`, where `signature` is the lowercase
hex Ed25519 signature over the UTF-8 bytes of the compact JSON serialization of
the `evidence` object in that key order. The configured public key must be an
Ed25519 PEM trusted and protected by the operator outside agent control.
Missing, untrusted, wrong-run or wrong-commit evidence blocks publication.
**No production reviewer, signer or trusted-key provisioning is implemented**;
the disposable fixture signer is not a substitute. Keep publication disabled
until an independently controlled reviewer and signing process are established.

The command requires a clean `cez/` branch with committed changes descending
from the base, and exactly one origin push URL matching the GitHub repository.
It refuses a missing, abbreviated or changed reviewed SHA and pushes that exact
commit without force, creates a draft PR, then posts its
URL as a Linear comment. It never merges or pushes the base branch. It does not
independently establish that the earlier automated reviewer reviewed that SHA,
that the human actually reviewed it, or that the agent could not tamper with
the results. Those checks are the operator's responsibility. Stop concurrent
writers and protect the remote branch; a later remote update may change a PR.

Publication receipts in `publish.sqlite` are claimed before remote actions.
**Any failure or interruption blocks automatic retry**, even a pre-push error:
inspect the receipt phase, remote branch, GitHub PR and Linear issue before any
manual reconciliation. A timeout or non-success response can be ambiguous;
never blindly delete a receipt or repeat a comment. Back up the database and
protect access to the Git and API credentials. No real GitHub or Linear writes
have been tested.

For a `comment_pending` receipt where the PR and Linear comment may already
exist, inspect their evidence without changing the receipt:

```sh
node studio/reconcile-publication.mjs OWNER/REPO cez/BRANCH
```

Set `STUDIO_STATE`, `GITHUB_TOKEN`, and `LINEAR_API_KEY` as above; only read
access is required. The command checks that the recorded draft PR has the same
repository, head, commit and recorded base, and that exactly one Linear comment has the
expected text. To mark that receipt complete, first stop every publisher using
the state, ensure no remote write remains in flight, inspect the PR and comment
yourself, then repeat with `--confirm-publisher-stopped`. This flag is an
operator assertion, not a lock. The command records the confirmation locally;
it does not push, create a PR, comment, or bypass the publication approval gate.
Matching text alone cannot prove who created a comment. Missing or duplicate
comments, mismatched PRs, other receipt phases, and incomplete history remain
blocked for manual investigation; never blindly replay an uncertain write.

The same command can inspect a `pr_pending` receipt. It searches all PR states
for the recorded feature branch and accepts only a single open draft with the
recorded commit, repository and expected issue text. After the same stopped-
publisher confirmation, it records the PR URL and advances to `comment_pending`;
it does **not** post a comment. New receipts record the base branch and recovery
checks the PR's base branch and repository. Older receipts without a recorded
base can be inspected but cannot be confirmed for PR-related recovery; handle
them manually after independently verifying the base and other details.
No matching PR, multiple results, pagination, altered PR text or other ambiguity
remains blocked. Do not create another PR on the assumption that a missing result
proves no earlier write succeeded.

For a `pushing` receipt, the same command checks the exact GitHub feature ref
and recorded commit. After the stopped-publisher confirmation it records the
verified push and advances to `pr_pending`; it does not push or create a PR.
A missing ref, a different commit, or an invalid response remains blocked. The
next PR step is still ambiguous and needs separate investigation and approval.

For a `claimed` receipt, the command can also record one already-existing draft
that matches the same checks as `pr_pending`. In normal operation the claim is
written before this publisher attempts a push or PR, so such a PR may have been
created independently; matching fields do not prove its origin. The operator
must verify its provenance, base branch and intended issue before confirming.
Confirmation records the PR locally as `comment_pending` and makes no remote
write. A missing, duplicated or mismatched PR remains blocked; the command does
not clear the claim or authorize a retry.

## Recovery and limitations

`POST /runs` has no idempotency key. Each new claim stores a random correlation
marker in the Cezar task. A later scan records exactly one matching run as
`provisional`, not publishable: the original submission may still be in flight.
Only its matching successful response finalizes the receipt; a different response
marks it `conflict`. If the response was lost or the process crashed, provisional
receipts stay blocked and require manual investigation. No match, multiple
matches, unavailable Cezar, and older markerless receipts also require review.
The inbox never automatically resubmits these claims.
Cezar run history retention or changes to its state can make reconciliation impossible.
This avoids blind duplicate launches but means unattended recovery is incomplete.
Back up `.studio-state/inbox.sqlite`
before any manual changes; never delete it to retry indiscriminately. If no run
was created and no request remains in flight, a knowledgeable operator can delete
the specific pending row by hash using SQLite and allow a retry.

To inspect a provisional or conflicting receipt, use its full SHA-256 hash:

```sh
node studio/reconcile-inbox.mjs HASH
```

The read-only report shows the receipt and matching Cezar run IDs, workflow,
status and task-hash match without printing idea text. Use the same `STUDIO_STATE`
and `CEZ_API_URL` as the inbox. New conflicts retain both the recovered run ID
and the conflicting submission-response ID; the watchdog checks both known IDs.
Older conflicts may be missing the second ID and require additional investigation.
To confirm a **provisional** receipt, first stop
every inbox process using this state, ensure no create request is still in flight,
and independently inspect Cezar history and the source issue. Then run:

```sh
node studio/reconcile-inbox.mjs HASH --confirm-inbox-stopped
```

This flag is an operator assertion, **not a lock or automatic stop check**. The
command requires one matching run, matching task hash, workflow and recorded ID,
then atomically records the confirmation and its timestamp in `reconciliation_audit`.
It neither retries nor publishes; the separate publication approval and gates
remain required. To quarantine a conflict after the same stop and investigation
steps, use:

```sh
node studio/reconcile-inbox.mjs HASH --confirm-inbox-stopped --quarantine-conflict
```

Quarantine requires two distinct recorded run IDs, preserves both and the source
binding, records an audit entry, and keeps the receipt blocked from publication
and retry. It does not cancel runs or undo remote effects; the watchdog continues
to inspect both IDs. It does not select a winner. Conflicts lacking a second ID
still require separate manual investigation. No
automatic promotion is safe if history is missing, incomplete or can change.
Receipts previously auto-recovered by older versions are indistinguishable
from direct submissions: audit them before publishing. Submitted receipts must be kept to preserve
deduplication. Do not run two independent cockpits on the same inbox; state and
project identity must remain stable. Plans need human review. Prompt instructions
are not security controls; do not process untrusted submissions unattended.

Tests: `npm test`. The integration test launches the real pinned Cezar in its
explicit mock-agent mode inside a disposable Git repository and checks that its
OpenCode mock starts in a worktree and reaches `waiting`; no model is called and
no plan is produced by the mock. A separate restart fixture simulates a lost
submission response, stops and restarts Cezar with the same state, and verifies
that the original run and worktree are retained, the receipt remains provisional,
and no duplicate is submitted or published. The feature-graph mock may fail
because it cannot produce the required planner verdict; the test preserves the
actual outcome. A separate `SIGKILL` case terminates Cezar's isolated process
group while a disposable workflow check is running. In a local run, Cezar
retained the run ID but reported it as running without a worktree path even
though the worktree remained on disk. Treat such runs as requiring operator
investigation; the test does not establish recovery from power loss.
On Linux, another credential-free fixture starts a normal-mode Cezar run using a
modified bundled mock OpenCode server, kills Cezar, and verifies that startup
sweeps its registered detached orphan while an unregistered server stays alive.
The run remains unique and its local-only receipt cannot be published. The
fixture holds the mock session open and sets `CEZ_AGENT_MODELS_LOCKED=1` only in
its isolated environment: the bundled mock does not implement `auth list` and
otherwise hangs during Cezar's provider probe. This bypass is not a production
recommendation or evidence of real-agent, credential, or power-loss recovery.
Another integration test runs the complete
feature graph in Cezar with a deliberately controlled test agent, real check
commands and Git operations in a temporary repository. It covers a test failure,
review-requested fix, feature-branch commit and exhausted retries. This is not
an end-to-end test of the feature graph with real model responses.
