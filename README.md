# Game studio: local planning prototype

This is an early prototype, not the complete autonomous studio. Cezar 0.20.0 is
pinned in `package-lock.json`; see [AUDIT.md](AUDIT.md) for the choice and risks.
The local inbox submits ideas to Cezar's `studio-plan` workflow, which asks
OpenCode for a plan. Cezar owns the queue and worktrees. It does not yet
implement tasks or create PRs, and the game and Linear integration are not built.

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

## Recovery and limitations

`POST /runs` has no idempotency key. A crash, HTTP error or timeout after a claim
leaves a `pending` receipt and **does not retry**: inspect Cezar's runs and logs
before manually resolving the receipt. This avoids blind duplicate launches but
means unattended recovery is incomplete. Back up `.studio-state/inbox.sqlite`
before any manual changes; never delete it to retry indiscriminately. If no run
was created, a knowledgeable operator can delete the specific pending row by
hash using SQLite and allow a retry. Submitted receipts must be kept to preserve
deduplication. Do not run two independent cockpits on the same inbox; state and
project identity must remain stable. Plans need human review. Prompt instructions
are not security controls; do not process untrusted submissions unattended.

Tests: `npm test`. The integration test launches the real pinned Cezar in its
explicit mock-agent mode inside a disposable Git repository and checks that its
OpenCode mock starts in a worktree and reaches `waiting`; no model is called and
no plan is produced by the mock.
