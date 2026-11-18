# Game Studio watcher

Put an idea in a Linear issue labeled `ai-game-studio` and move it to **Ready**.
The watcher processes one issue at a time, after any Linear prerequisites are
Done. It starts from current GitHub `main`, runs OpenCode with `openai/gpt-6.2-sol`
in the existing game-only sandbox, then runs Godot smoke, regression, UI and
graphical screenshot checks. Those checks test behavior and screenshot integrity,
not subjective art quality.

The host pushes the tested tree to a feature branch and opens one PR to `main`.
If GitHub Actions fails, the watcher sends the failed step and relevant log
lines back to OpenCode, retests locally and pushes a fast-forward to that same
PR. It merges only the exact passing head of its own PR, under GitHub's rules.
Once the fetched `main` contains the verified two-parent merge commit, the
watcher attaches its PR URL and merge SHA to Linear and marks the issue Done.

## Host setup

- Run the one `game-studio.service` on Linux with Node, OpenCode, Godot 4.3,
  Bubblewrap, Xvfb, and ImageMagick. The service uses a linked checkout at
  `~/Projects/game-studio-github-first`; its `.studio-state` points to the
  original private state under `~/Projects/game-studio-reconciled`.
- Preserve `.studio-state/once.json`, the existing dedicated OpenCode profile,
  and the host-only `~/.config/game-studio/{github,linear}.key` files (0600).
  GitHub needs Contents and Pull Requests read/write, plus Actions read/write
  for logs and reruns. Linear needs issue and attachment writes.
- GitHub `main` must have no bypass, require a PR and a strict GitHub Actions
  `test` check, block deletion and force-pushes, and allow merge commits only,
  without human approvals. Land the migration PR as the repository owner
  before enabling the service. The watcher will not merge that PR itself.
- On the merged checkout, run `npm run studio:draft -- --check` before
  installing the unit. If an old unit has a `checkout.conf` drop-in, its
  working directory must also point at the linked checkout; make sure the old
  watcher is stopped before enabling the new one.

## Recovery

The common Git lock prevents simultaneous old and new watchers. Leave the
original worktrees and `refs/studio/*` intact. The configured GAB-19 recovery
has a local claim; the watcher verifies it and copies its allowlisted edits
without modifying the original. Completed jobs are not replayed.

`.studio-state/github` contains the durable issue journal and QA evidence.
Transient errors are retried. After four failed implementation/QA checkpoints
or a changed PR/branch, the watcher records a blocker and moves to the next
independent issue. If an external merge puts a PR behind or causes a conflict,
the watcher retains the branch instead of merging an untested tree. Repo and
workflow edits are outside the agent sandbox.
