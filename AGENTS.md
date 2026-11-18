# Studio rules

Use Godot 4 and GDScript for the game. Prefer editable SVG art and accessible,
consistent UI. Test behavior, not just compilation. Record decisions and
handoffs in the repository. Escalate major creative direction changes and risky
operations rather than guessing. Worktrees do not provide a security sandbox.

Coding agents may perform infrastructure maintenance explicitly authorized by
the repository owner, including pushing feature or migration branches, creating
or updating PRs, and automatically merging authorized PRs. For a PR targeting
`main`, keep branch protection enabled and use a merge commit only after every
required CI check passes on the exact current PR head. Never push directly to
`main`, force-push, bypass failing tests or protection, delete user data, or
expose credentials. Use credentials only on the trusted host, never inside the
game-editing sandbox.

The owner-authorized, host-side Game Studio watcher may publish its own validated
Linear feature branches and create PRs automatically. It may merge only its own
PRs targeting protected `main`, after required GitHub Actions checks succeed on
the exact current head. It uses only merge commits, never bypasses protection,
and marks Linear Done only after the tested commit is confirmed on `main`.
