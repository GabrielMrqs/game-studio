# Initial audit and architecture decision

Audit date: 2026-11-16. The workspace was empty and was not a Git repository; no existing project, plugin, or credential was modified. Git 2.56.1, Node 26.13.1, npm 12.2.2, OpenCode 2.2.7, Docker and Compose 5.7.1 are installed. The Docker daemon answered with version 29.9.3. Godot and the GitHub CLI were not on PATH. Git's global author name and email are configured. An OpenCode service is running; this does not establish that a model can actually be used unattended. LINEAR_API_KEY, LINEAR_WEBHOOK_SECRET, GITHUB_TOKEN, GH_TOKEN and OPENAI_API_KEY were absent from this process environment; credentials may exist elsewhere and were not inspected. There is no Git remote to receive a PR.

## Existing options

| Project | License and maintenance signals | Fit and risks |
| --- | --- | --- |
| [Cezar](https://github.com/open-mercato/cezar) | MIT; active TypeScript project with tests and security policy | Best starting point: OpenCode, queued worktrees, persistent run logs, workflows, review gates and Linear polling. Its tracker automations currently support Linear issue creation, not status/label-change events; no signed inbound Linear webhook is documented. Its agents are trusted local processes, not a security sandbox. Queue recovery is not an exactly-once guarantee across independent servers. |
| [OpenAI Symphony](https://github.com/openai/symphony) | Apache-2.0; engineering preview | Strong Linear-first architecture and published specification, but reference implementation uses Elixir and Codex, so changing the agent backend is a substantial integration. Upstream explicitly says trusted environments only. |
| [OpenEngineer](https://github.com/consuelohq/openengineer) | MIT; comparatively small public history | Has Linear, OpenCode and a webhook receiver, but documented workflow uses tmux and includes automatic merge/deploy, contrary to the requested guardrails. Its claimed production throughput is not independently verified. |
| [Twinpod](https://github.com/mkrueger12/twinpod) | Check upstream license and release history before use | OpenCode-backed Linear poller with explicit trust boundaries. Smaller alternative; completeness and operational track record not yet verified. |
| [Demetra](https://github.com/manti-by/demetra) | Check upstream license and release history before use | OpenCode planning, review and Linear with durable database; Python and project-specific tooling add integration cost. Claims not independently verified. |

Choose **Cezar as the orchestration base**, not a new scheduler. Pin an audited release, keep its existing queue/worktree machinery, and add only missing inbox/webhook glue after verifying its public API. Do not represent its polling as a signed-webhook implementation or its review gate as an independently verified reviewer. An agent with shell access can read credentials available to its user and access the network; a worktree is not a sandbox. Run on a dedicated low-privilege host/account with narrowly scoped credentials, and do not expose the cockpit directly to the internet.

## Adventure framework

[Popochiu](https://github.com/carenalgas/popochiu) is MIT-licensed, supports high-resolution 2D, rooms, hotspots, inventory, dialogue, save/load and transitions. Stable 2.2.1 targets Godot 4.7 and requires editor setup. It is a good fit to evaluate with a pinned Godot version rather than recreating an adventure engine. Neither Godot nor the plugin is installed in this workspace yet; compatibility and headless testing remain unverified.

## Required safety boundaries

No direct main pushes, automatic merges, publication, destructive operations, or credential copying. A feature branch and a human-reviewed PR are the intended output. Local inbox data and tracker descriptions are untrusted; prompts alone cannot enforce shell restrictions. Do not enable unattended processing until execution isolation, credential exposure, budgets, crash recovery, and behavior under retries have been tested. Real Linear and GitHub integration needs user-provided access and a destination repository; no external connectivity has been claimed.
