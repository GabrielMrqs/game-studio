# Supervised execution assessment

2026-11-17: No real feature run was started. The current checkout has extensive
uncommitted changes, including the entire `game/` directory and feature workflow;
a Cezar worktree from `HEAD` would not contain them. Do not commit or overwrite
that work as a side effect of a test.

Evidence from this checkout:

- `npm test -- --test-concurrency=1`: 55 passed, 3 opt-in Docker tests skipped.
- `GODOT_BIN=/tmp/opencode/godot43/Godot_v4.3-stable_linux.x86_64 sh studio/test-game.sh`:
  Godot 4.3 import, startup, and behavioral smoke checks passed. The binary is
  host-specific; plain `godot` was not on PATH.
- `opencode run --model openai/gpt-6.1-terra 'Reply with exactly: AUTHENTICATED. Do not use any tools.'`:
  returned `AUTHENTICATED` using a real authenticated model. This was a
  no-tool connectivity probe, not a feature workflow or isolation test.
- The Cezar test observed an actual shell check run before its inbox receipt
  held the assigned run ID. Other tests use mocks or scripted models; see
  `OPEN_ISSUES.md` and `OPERATIONS.md` for their precise scope.

For a safe supervised feature test, first provide a dedicated low-privilege
environment with a provider credential and spending limit, with access restricted
to an explicitly prepared snapshot of the intended project. Keep this checkout
and its uncommitted work intact. The snapshot needs its own baseline commit so
that Cezar can create a feature worktree containing the game. No remote,
publication credentials, or automatic recovery should be configured.

For 24/7 use, the smallest identified direction is an independently enforced
pre-execution barrier covering Cezar's own shell checks as well as agent
launches, with durable run/container binding and fail-closed reconciliation.
A post-response binding or model gateway alone is too late. Whole-run process
containment and verified recovery are also needed: cancellation of the Cezar
process group did not stop a synthetic child in a separate process group, and
OpenCode workflow restart can create a new session. Keep the existing startup
guard and manual publication gates; do not enable unattended operation.
