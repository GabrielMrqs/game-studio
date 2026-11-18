# Studio rules

Use Godot 4 and GDScript for the game. Prefer editable SVG art and accessible,
consistent UI. Test behavior, not just compilation. Record decisions and
handoffs in the repository. Escalate major creative direction changes and risky
operations rather than guessing. Coding agents never push directly to main,
merge, publish, delete user data, or expose secrets. Worktrees do not provide a
security sandbox.

The owner-authorized, host-side Game Studio watcher may publish its own validated
Linear feature branches and create PRs automatically. It may merge only its own
PRs targeting protected `main`, after required GitHub Actions checks succeed on
the exact current head. It uses only merge commits, never bypasses protection,
and marks Linear Done only after the tested commit is confirmed on `main`.
