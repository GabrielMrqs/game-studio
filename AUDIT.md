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

## Follow-up: OpenCode restart alternative

On 2026-11-17, the npm registry still reported Cezar 0.20.0 as latest; its
OpenCode V2 runner opens a new session rather than reopening the recorded one.
We also inspected [skorokithakis/symphony](https://github.com/skorokithakis/symphony)
at commit [`756b515840e138aa941e1ab6b5bfc2bf504cbef9`](https://github.com/skorokithakis/symphony/tree/756b515840e138aa941e1ab6b5bfc2bf504cbef9).
It supports OpenCode V2 and passes a known session ID to the supported CLI.
Its own recovery tests also demonstrate that an interrupted first turn with no
recorded session ID is **started again**, potentially repeating side effects;
with a recorded session and no pending comments it parks for input. Its README's
blanket startup-parking description does not describe both cases.

In a disposable, network-disabled bubblewrap environment with fake tracker and
agent subprocesses, its selected upstream recovery and OpenCode argv tests
passed **24/24**. They do not establish behavior with a real OpenCode session,
a process kill during a side effect, live trackers, or provider billing. Its
documented sandbox shares networking and notes that credentials or SSH-agent
sockets may be reachable; workspace cleanup also needs review against the
no-deletion policy. The upstream `LICENSE` file says AGPL-3.0 while its README
and package metadata say MIT; resolve that conflict before adoption. It is a
Python daemon and would require replacing or integrating existing workflow,
inbox and publication gates. Do not switch orchestrators on this evidence.
Keep Cezar's startup and publication guards enabled.

## Follow-up: Temporal as a possible execution coordinator

On 2026-11-17, [Temporal's documented signal and wait-condition pattern](https://learn.temporal.io/tutorials/ai/building-durable-ai-applications/human-in-the-loop/)
was evaluated as a possible durable pre-activity hold. Its server repository
is [MIT licensed](https://github.com/temporalio/temporal/blob/main/LICENSE).
This is a candidate for coordinating a separately designed execution system,
not a demonstrated Cezar pause mechanism: waiting in a Temporal workflow before
calling Cezar still cannot bind Cezar's internally assigned run ID before Cezar
starts its own steps. Replacing Cezar's workflow runner or obtaining a supported
paused-create API would be a substantial integration.

[Temporal's retry documentation](https://docs.temporal.io/encyclopedia/retry-policies)
says Activities retry by default, with unlimited maximum attempts. A real
integration must explicitly bound retries and reconcile uncertain side effects;
durable workflow history alone is not exactly-once container or agent execution,
a sandbox, a spending ceiling, or human publication approval. No Temporal CLI
or SDK was installed in this workspace at evaluation time. No Temporal server,
binding barrier, crash recovery or agent/check execution was tested. Keep the
existing Cezar and publication guards in place; do not switch orchestrators
based on this documentation review.
