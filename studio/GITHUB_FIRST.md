# GitHub-first studio

Create issues in the configured Linear team/project with the studio label and
put them in **Ready**. Use Linear's **blocked by** relations for prerequisites.
The watcher records the issue UUID and immutable branch name before changing
Linear, implements in a private worktree with GPT-6.2 Sol, runs Godot QA, and
publishes the tested commit as a Draft PR. Linear gets an attachment and moves
to **In Review**, never Done on publication. If `doneId` is configured, the
watcher marks Done only after GitHub confirms the PR was merged to `main` and
the tested commit is in `main`. GitHub links and the journal retain the exact SHA.

Independent PRs target `main`. A dependent PR targets the nearest compatible
open parent; once that parent lands in `main`, the watcher retargets the child.
Review and merge parents first, using **merge commits**. A job that requires
several divergent unmerged branches waits until its prerequisites form one
chain. A canceled or externally rewritten stack is not merged or rewritten
by the watcher.

Godot import, startup, gameplay smoke, baseline regressions, UI navigation and
screenshot integrity gate publishing. The **Godot QA** CI artifact contains
logs and real Xvfb menu/gameplay screenshots. The Draft PR distinguishes local
validation from CI and flags visual quality as unverified. Screenshots do not
require approval before publication.

## One-time migration

1. Wait for the old watcher to be idle, stop it, and verify `MainPID=0` and
   its cgroup is empty. Keep all branches, worktrees, `refs/studio/*`, and
   `.studio-state` files and protect backups as sensitive. Do not clear the
   legacy active gate.
2. Protect GitHub `main`: require PRs, review and CI (`test`), block force pushes
   and deletion, and disallow the studio credential from bypassing rules.
   In repository settings, enable merge commits and disable squash/rebase
   merges. An authorized operator can publish the one-time bootstrap:

   ```sh
   set -eu
   cd ~/Projects/game-studio-reconciled
   git fetch origin main
   git merge-base --is-ancestor origin/main migration/github-first-bootstrap
   git push origin refs/heads/migration/github-first-bootstrap:refs/heads/migration/github-first-bootstrap
   gh pr create --draft --base main --head migration/github-first-bootstrap \
     --title "Bootstrap the GitHub-first Game Studio" \
     --body "Imports the validated Godot game and studio from local migration/github-first (077c8e5), based on GitHub main. Preserves historical branches and all local Linear recovery state."
   ```

   Stop if the ancestry check fails. Use operator credentials for this push:
   it introduces a workflow file. Review the PR and CI before marking it ready
   and merging with a **merge commit**. The bootstrap imports the validated
   game tree without joining the unrelated histories. The watcher refuses a
   non-playable `main`.
3. Provision a fine-grained GitHub PAT for **only this repository** with Contents
   read/write and Pull requests read/write (plus implicit Metadata read). Save
   it in `~/.config/game-studio/github.key` (0600). Do not use the broad interactive
   `gh` login or put this credential in the OpenCode profile. Use a Linear key
   able to read issues and update issue states and attachments, saved privately
   at `~/.config/game-studio/linear.key`.
4. The existing `.studio-state/once.json` already points to this repository,
   Linear's In Review state, and `recoveryRun: "once-DBOHsX"` for GAB-19.
   The watcher verifies the legacy worktree/ref/receipt tuple and exact
   imported game tree. It copies only allowlisted edits whose base entries
   have not changed, without writing to the original worktree or refs.
5. With Linux, OpenCode, Godot 4.3, Bubblewrap, Xvfb and ImageMagick installed,
   activate only after the PR has merged. Use a linked checkout so the
   current checkout, its local changes, and the original state directory
   stay in place. The checkout and symlink are one-time setup:

   ```sh
   set -eu
   cd ~/Projects/game-studio-reconciled
   git fetch origin main
   git merge-base --is-ancestor migration/github-first-bootstrap origin/main
   git worktree add --detach ~/Projects/game-studio-github-first origin/main
   ln -s "$PWD/.studio-state" ~/Projects/game-studio-github-first/.studio-state
   cd ~/Projects/game-studio-github-first
   npm run studio:draft -- --check
   unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
   mkdir -p "$unit_dir"
   sed 's@%h/Projects/game-studio-reconciled@%h/Projects/game-studio-github-first@g' \
     studio/game-studio.service > "$unit_dir/game-studio.service"
   systemctl --user daemon-reload
   systemctl --user enable --now game-studio.service
   systemctl --user status game-studio.service
   tail -f .studio-state/watch-service.log
   ```

   No initial supervised claim or manual branch promotion is necessary afterward.

## Resume and diagnose

The Git common-directory lock prevents concurrent legacy/new writers. The
`.studio-state/github` journal records claims, checkpoint attempts, tested
trees, commits, PRs and Linear writeback. Worktrees and QA logs are retained
there. The watcher resumes from disk, uses capped API retries and at most four
model/QA checkpoints, and looks up the immutable PR head before attempting to
create it again. It does not overwrite a divergent GitHub branch. It attaches
permanent blockers to Linear while continuing independent work. To correct a
terminal blocker without replaying its claim, create a new Linear issue with
the corrected scope and link it to the blocked issue.

GitHub and Linear credentials are available only to the host-side runner.
OpenCode mounts a dedicated model profile and only the candidate's `game/`;
Godot validation uses a separate, networkless sandbox. Do not add GitHub,
Linear, MCP or unrelated credentials to the model profile.
