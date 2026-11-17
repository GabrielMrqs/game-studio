# Operations: isolated Compose preview

**This deployment is a dry-run fixture, not the requested unattended studio.**
It contains no OpenCode binary, model access, GitHub/Linear credentials or real
publisher. `CEZ_DRY_RUN=1` uses Cezar's mock agent; it cannot produce real
plans or code. Do not interpret mock PRs or test results as real. Real-mode
token/cost budgets and isolation have not been implemented or verified. Do not
add credentials or disable dry-run in this configuration.

## Start and inspect

Requires Linux Docker Engine and Compose with host networking. From this folder:

```sh
docker compose up -d --build --wait
docker compose ps
docker compose logs --tail 100 cezar inbox
```

Cezar listens at `http://127.0.0.1:14321` on the host. It has no authentication;
do not forward the port or expose it through a reverse proxy. Any local host
process can access it. Both containers use host networking, which means they can
also access host-network services and the Internet. The Cezar cockpit can run
workflow **shell checks for real** even in mock mode. Only trusted users should
access it, and it is not a security sandbox for untrusted prompts.

To submit a test idea without mounting a host directory:

```sh
docker compose exec -T inbox node -e "require('fs').writeFileSync('/ideas/example.md','A harmless test idea')"
docker compose exec -T inbox node studio/inbox.mjs --once
docker compose exec -T inbox node -e "console.log(require('node:sqlite').DatabaseSync ? 'SQLite available' : 'missing')"
```

Use the cockpit for run status, or `docker compose logs inbox`. The inbox health
check monitors a successful-scan heartbeat; Cezar's checks its HTTP health.
Docker health checks do not themselves restart an unhealthy container. Restart
policies restart exited containers, not an unhealthy but running process.

The base Compose Cezar command runs `studio/startup-guard.mjs` before starting
Cezar. It refuses unreadable or malformed indexes, unrecognized run IDs or
statuses, missing indexes with existing run/worktree state, and **all persisted
queued, running, waiting, or auto-resuming failed runs**, even when their paths
are valid. Review-state runs may start only with a valid recorded path. For these runs it
also requires the standard per-run absolute path, no symlinked path components,
a registered Git worktree belonging to this repository, and a matching branch
when one is recorded. It fails closed if Git or filesystem checks fail. The guard does not
change the index or worktrees. On refusal, inspect the Cezar logs and stop
restart attempts; back up the project and other state volumes together and
investigate before restarting. An ordinary queued run may lack a path before its
worktree is created, so this check can block safe restarts too. Do not edit or
delete records merely to bypass the guard; reconcile the run and session first.
The guard also reads `automations.json` before the run index. It refuses any
enabled deferred task, a deferred launch marked `launching` or failed as
`ambiguous`, any deferred record containing reserved run IDs, and any deferred
record with `manualRequested: true`, even if no run index exists. It also
refuses malformed automation indexes or unrecognized deferred records. This
deliberately blocks ordinary enabled future deferred tasks as well as interrupted
ones; it neither inspects external binding state nor makes replay safe. Stop all
writers and preserve both automation and run state for operator review.

A credential-free integrated Cezar/OpenCode container fixture exposed a replay
risk: without the guard, Cezar restarted an active run under a different
OpenCode session. With the guard, a restarted container refuses to start Cezar;
the persisted run/session binding, inbox receipt, tool output and gateway quota
remain available for operator review. A follow-up fixture explicitly continues
the recorded OpenCode session via its CLI while Cezar stays blocked; it verifies
the prior tool result without changing Cezar's index or repeating the tool.
This is a controlled test, not a production recovery procedure: it does not
resume Cezar's workflow or reconcile its state. No automatic continuation is claimed.
The same disposable test has an explicit **fixture-only** unguarded negative
control: Cezar 0.20.0 replaced the recorded OpenCode session and attempted the
already-completed tool again. An exclusive write prevented the repeated
fixture side effect. Never use this negative-control mode for a real project.
After the integrated container is killed, the fixture also copies its OpenCode
database and any WAL into a private temporary directory and queries the copy
read-only. For the pinned OpenCode fixture it checks that the Cezar-recorded
session ID exists, its directory matches the Cezar worktree, and an assistant
message contains the completed fixture-tool result. It compares the original
database and sidecar bytes before and after inspection. This is a test of that
fixture's internal database schema, not a supported general-purpose recovery
procedure; database snapshots may contain credentials and conversation data.
The operator inspector above still reports the OpenCode store as `not_checked`.
The startup guard also blocks when any entry under `.ai/cezar/worktrees`
has no matching run ID in the persisted index, including when the index is
present but stale. It leaves both the index and worktree untouched for operator
investigation; it does not reconstruct the missing run or authorize recovery.
It likewise blocks a UUID-named Cezar event log absent from the index, even
when no worktree remains. Historical orphan logs also require operator review;
the guard neither deletes nor reconciles them.
A run in `review` also requires a nonempty recorded branch matching its
registered worktree; missing or mismatched branch metadata blocks startup for
operator investigation, even if the worktree itself is readable.
Inbox and publication reconciliation open existing receipt databases only:
if either database is missing, inspection and confirmed reconciliation fail
without creating a replacement or contacting external services. Investigate
the missing state and backups rather than treating it as a fresh receipt store.
Once the watchdog records cancellation intent, it retries cancellation whenever
that run is still active, even if later usage or metadata no longer exceeds
the original limit. An accepted API response is not proof that all child
processes stopped. Reusing an active run after cancellation therefore also
requires operator investigation; do not delete watchdog records to bypass it.

On 2026-11-17, the base Compose worker and inbox were also tested together in
the disposable networkless project `studio-integration-20261117b`. Two
identical local ideas produced one submitted receipt and one mock Cezar run.
Publication without `--approve` was refused. After both services stopped, a
restart of Cezar exited 1 because the persisted run was waiting; a separate
read-only, networkless container confirmed the one run and its matching receipt
were still present. The fixture used a graceful stop, not a crash, and its
stopped containers and named volumes are retained; the Cezar restart policy was
disabled to avoid a restart loop. No existing resources were removed.

The check assumes exclusive access to the project during startup. It does not
fully validate Cezar's run schema or verify worktree contents, stop already-running detached
processes, prevent a different Cezar invocation from bypassing it, or cover the
separate socket/gateway fixtures. It is not a security boundary. Existing
project volumes retain their old files after an image rebuild; an older volume
without the guard will fail to start until the operator safely upgrades its
project files after backup. Never delete the volume to install the guard.

Credential-free feature-graph tests show that planner escalation and repeated
review rejection block the explicit feature-commit node and publication. They
also show Cezar 0.20.0 can create `cezar autosave (turn end)` or
`cezar autosave (run finalize)` commits on the isolated feature branch even
when the workflow fails; `CEZ_AUTOSAVE` does not disable these flushes. Such
commits are not approval, and the tests do not demonstrate that failure leaves
the branch commit-free. No real reviewer or live publisher was used.
The fixture explicitly tested `CEZ_AUTOSAVE=0`: it still observed both
finalization and turn-end autosaves in the respective blocked scenarios. No
supported configuration to disable those flushes was found in Cezar 0.20.0.
For both failed runs, the fixture also verified that the approval CLI refused
without `--approve`, the guarded publisher refused even when called directly,
and no corresponding branch appeared on its disposable Git remote. A separate
test checks that a failed or active run is refused even if its recorded graph
contains all success edges. These are checks of the studio publication path,
not a security boundary: direct Git, Cezar cockpit/API actions, or direct use
of the lower-level publisher can bypass it if given access and credentials.
The publication CLI requires a full SHA that the human has reviewed, checks it
against HEAD, and pushes that exact commit. The earlier automated graph review
is not independently bound to that SHA, and the command cannot prove a human
actually reviewed it. Keep real publication access under human control and stop
concurrent writers.
The publication CLI requires signed run-and-commit approval and an operator-
configured trusted Ed25519 public key in addition to explicit human approval.
The credential-free feature fixture tests invalid or stale evidence and failed
workflows without live remote writes. It does not provision a trusted reviewer
or verify reviewer isolation; do not use its signatures as production evidence.
`studio/isolated-reviewer.test.mjs` additionally runs a scripted reviewer in
network-isolated bubblewrap with a read-only fixture repository and a
disposable signing key. It signs only after inspecting the specified Git commit;
the fixture publication gate rejects absent, untrusted and stale evidence and
requires explicit fixture approval. This is a deterministic content check, not
an OpenCode reviewer or a security audit of bubblewrap. No production signer or
trusted-key provisioning is provided. The test is skipped
when Linux bubblewrap is unavailable.
An additional opt-in fixture runs an actual OpenCode reviewer against a
scripted model via the synthetic gateway:

```sh
STUDIO_TEST_DOCKER_ISOLATION=1 node --test studio/opencode-reviewer.test.mjs
```

The networkless reviewer reads the specified commit from a read-only fixture
repository; a separate host-side fixture signer signs only after the scripted
model receives the commit-specific tool result. The fixture gate checks
approval and rejects missing, untrusted or stale evidence before its mock
publisher. The model and review criterion are scripted; this does not establish
real review quality, signer isolation from the host, or production key custody.
It requires the locally cached OpenCode fixture image described below.

### Inspect an interrupted run

Stop all Cezar, OpenCode and inbox writers first, preserve the project and state
volumes together, and run from the project checkout with its state directory:

```sh
STUDIO_STATE=/path/to/state npm run inspect-recovery -- RUN_ID
```

The command reads the persisted Cezar index, checks the expected worktree
against Git, and correlates matching inbox receipts by run ID, conflicting
run ID, or the stored task marker. `marker_only` is an uncertain submission,
not confirmation that a run is safe to publish. It reports session IDs
**recorded by Cezar**, but deliberately does not open OpenCode's session store
or check the Linear database; both are marked `not_checked`. It does not show
task text or receipt details, alter state, start services, reconcile a run, or
grant publication approval.

For a strictly read-only database snapshot it refuses receipt inspection
while a SQLite WAL or rollback journal exists; do not delete those files to
make the command pass. Stop writers and investigate or back up the complete
database and sidecars. The command cannot prove writers are stopped or obtain
an atomic snapshot across files, so its output alone is not evidence that a
run is safe to resume or publish. Missing, invalid, ambiguous and unsupported
state is reported or refused rather than repaired.
The CLI exits nonzero for an unrecognized run status, an unavailable or
mismatched worktree, a missing or mismatched recorded branch, or unless exactly
one submitted primary receipt matches the workflow and task. It still prints the
report for investigation. A zero exit means only these checks passed; it does not
verify the OpenCode store or authorize continuation or publication.

On 2026-11-17, a disposable networkless Compose project
`studio-guard-check-20261117` started the base worker healthy, submitted a
mock run, and killed its Cezar container. That run's worktree path survived the
kill, so the missing-path condition was **seeded** in the stopped fixture's
index after backing it up. Starting the same Compose service exited with code 1
and logged `Cezar startup blocked`; the index hash and worktree were unchanged.
Running the publication CLI without `--approve` was refused. The test used no
real credentials or publication and does not establish real-agent recovery.
Its stopped container and named volumes are retained for inspection; the
fixture container's restart policy was disabled to prevent a restart loop.

Before the stricter interrupted-run guard, networkless project
`studio-path-guard-20261117` restarted healthy with a real mock-run worktree and
matching persisted path and branch.
After a clean stop, its backed-up fixture index was changed to point that run
at `/project` instead. The same Compose startup exited 1 with an invalid or
mismatched worktree error; the changed index hash and real worktree were
unchanged. Publication without `--approve` was refused. The wrong path was
seeded for the test, not observed after a crash. The stopped fixture container
and its volumes remain for inspection; its restart policy was disabled.

For a read-only JSON summary inside the preview's shared state, run
`docker compose exec -T inbox node studio/status.mjs`. Receipt counts distinguish
pending, provisional, conflict and quarantined items; idea-file counts include
files already processed. Missing optional databases are reported as such. This
is a snapshot, not a health guarantee or a way to approve publication.

## Persistence and upgrades

Named volumes hold the fixture repository/worktrees (`project`), inbox receipts
(`state`), ideas (`ideas`) and Cezar home (`cezar-home`). The fixture repository
is created inside the image with a dummy local Git identity and has no remote. It
is a copy, not your host checkout. Docker initializes a new project volume from
the image only once: rebuilding an image does **not** update an existing project
volume. Plan upgrades and back up volumes before changing them; never delete a
volume to upgrade. Keep all four backups consistent, especially idea files and
SQLite receipts. `docker compose stop` retains the volumes. Do not use `down -v`
or volume pruning on a project whose data you want to retain.

The build context is allowlisted by `.dockerignore`. No home-directory or host
project bind mount is used. Containers run as non-root with read-only root
filesystems, writable named volumes/tmpfs, dropped capabilities, no-new-privileges,
and CPU, memory and PID ceilings. These limits do **not** enforce a model token,
spending, time or network budget, and do not make local same-user access safe.
The demo inbox does not ingest Linear; configure and validate that separately
only after designing secure credentials and recovery.

## Offline network-isolation check

An opt-in adversarial process fixture checks a narrower proposed isolation
boundary without credentials:

```sh
STUDIO_TEST_DOCKER_ISOLATION=1 node --test studio/isolation.test.mjs
```

It requires Docker, the locally cached pinned Node image from `Dockerfile`, and
an OpenCode fixture image. The latter defaults to a locally cached image ID;
on another host, build `Dockerfile.cezar-fixture` and set
`STUDIO_ISOLATION_OPENCODE_IMAGE` to its image name. The test itself does not
pull images or create Docker networks. A non-root, networkless,
read-only container tests a synthetic host-only secret file and environment
variable, a read-only synthetic main checkout, writable scratch space, Docker
socket absence, host loopback, and one external address. It removes only its
own temporary host files and `--rm` container. A second test uses an actual
OpenCode shell tool driven by a scripted Responses endpoint outside the agent
container. The existing quota gateway injects a synthetic upstream key; a
Unix socket and container-local relay provide model access without external
container networking. The fixture verifies the upstream received the key,
quota was charged, and the shell tool could not read the key file or find the
key in its environment, or reach the tested host and external addresses.
It also exhausts the fixture request quota and verifies OpenCode cannot complete
or run its tool, no further request reaches the mock upstream, and the gateway
still refuses requests after reopening the quota database. The test terminates
the worker's retries after seven seconds; it does not prove OpenCode exits by
itself on quota exhaustion.
The same fixture starts Cezar's feature workflow with the exhausted gateway and
checks for ten seconds that the run does not reach commit or a successful review
state, its main and worktree HEADs stay unchanged, and publication without
`--approve` is refused. It observes the gateway's 429 responses and confirms
no request reaches the mock upstream. The existing watchdog then requests a
wall-clock cancellation, which Cezar accepts; the run reaches `cancelled`
without scheduled auto-resume or a commit. The fixture then stops Cezar. This
also identifies the Cezar-owned OpenCode server through its process registry,
confirms its original PID/start-time identity is no longer executing, and
checks that its detached process group has no live members before stopping
Cezar. A fixture-only OpenCode launch wrapper also starts a synthetic child
with its own process group. That child continued writing a disposable heartbeat
after watchdog cancellation and server-group exit. The test harness then kills
the entire disposable, networkless per-run container; Docker reports exit 137
and the persisted heartbeat stops advancing. This demonstrates both the gap in
Cezar's process-group cleanup and the tested container-level containment for
this synthetic child. The fixture-only external controller checks a submitted
receipt, accepted watchdog cancellation, exact container ID, fixture labels and
disabled restart policy before killing it; the receipt and cancellation record
remain present afterwards. The fixture stores the run ID, container ID, token
and termination phase in a controller-owned SQLite database outside the agent
workspace. A controller subprocess is killed after Docker kills the container
but before it records completion; a new controller verifies the labels and
exit status and records completion without a second kill. This is not a
production trust boundary: the harness creates the binding only after the run
exists, assumes a single controller and protected host files, and does not
automatically reconcile an interruption before binding or enforce durability
across power loss.
Credential-free unit fixtures now verify that a missing binding, a controller
killed after creating an empty binding file, an unavailable container, and
ambiguous Docker inspection results all stop without signaling a container.
A simulated controller SIGKILL after recording termination intent but before
sending a kill is retried only against the same verified running fixture
container. A fixture-only pre-creation reservation now supports read-only
discovery after a creator process is killed immediately after `docker create`.
It checks for exactly one fully identified container with matching fixture
labels and no restart policy, then reports `operator_review`; it never binds,
starts, or kills it. Missing and ambiguous matches fail closed. The reservation
has no Cezar run ID, Docker labels can be spoofed by a Docker-privileged actor,
and discovery is not an atomic snapshot or an automatic recovery procedure.
The pinned Cezar create-run API generates its own run ID rather than accepting
a caller-supplied ID (verified in the dry-run fixture). When Cezar itself is
inside the per-run container, the token reserved before container creation
cannot by itself establish a binding to that later run before execution. Do not
use this fixture as a production launch barrier.
The dry-run Cezar integration test also observes a workflow step start while
the create response is withheld and its inbox receipt has no run ID. Do not
assume that binding after the response precedes execution. A model gateway
or an agent-editable launcher alone is not an independent execution barrier.
The current worker does not automatically terminate a
per-run container on cancellation, and this test does not prove containment
against container escapes or safety for real-provider failures.
The fixture also stops the gateway after an OpenCode tool starts, verifies that
the interrupted session does not report success (terminating its retry after
seven seconds), then restarts the gateway with the same quota database and
starts another session. During that session it stops and restarts the gateway
again; the same running OpenCode session retries and completes. An exclusive
scratch write and model tool-call count check that the fixture tool is not
repeated, while quota persists across both restarts. Another case kills the
OpenCode process after its tool result, then starts a new process with the same
session ID and persisted fixture home. The scripted model sees the prior tool
result, the tool is not repeated, the quota stays intact, and publication
without `--approve` is refused. A further case kills and restarts the same
networkless container using a disposable bind-mounted workspace, then confirms
the same session and prior tool result survive without repeating the tool.
The gateway reopens its existing quota database. This does not test host power
loss or real model behavior; the test removes only its own container and
temporary files.
The gateway and scripted upstream run in the test process, not separate
production services; its temporary socket is permissive for the fixture. This
is not a real credential test, container-escape
assessment, or a production deployment:
the existing Compose worker does not use this checkout boundary, and a
networkless agent cannot reach a remote model or integrations. Production
credential injection, network allowlisting and isolation remain unverified.

For a stronger **offline mock** test, use a separate Compose project name and
the network override:

```sh
docker compose -p studio-offline -f compose.yaml -f compose.isolated.yaml up -d --build --wait
docker compose -p studio-offline -f compose.yaml -f compose.isolated.yaml ps
docker compose -p studio-offline -f compose.yaml -f compose.isolated.yaml logs --tail 100
docker compose -p studio-offline -f compose.yaml -f compose.isolated.yaml stop
```

Cezar has a private network namespace with only loopback; the inbox shares it.
The host cannot access the cockpit over HTTP, and neither service can contact
Linear, GitHub, or a remote model. This is a network isolation test, not a real
agent deployment. Named volumes remain after `stop`.

## Provider spending prerequisite

For an OpenAI API deployment, an authorized project owner must configure a
dedicated project in **Platform settings → Organization → Projects → project →
Limits**, set the monthly spend limit, and enable **Enforce a hard limit**.
Verify the key belongs only to that project and model access/rate limits are
restricted. A notification-only budget does not stop requests, and OpenAI says
hard-limit enforcement can lag and slightly exceed the configured amount:
[Managing projects](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform).
These API controls do not automatically apply to a ChatGPT subscription login.
Do not paste credentials into issues, source files, logs, or chat. This project
cannot verify a provider's account setting and does not provision or enforce it.
Even with a provider cap, a separate model gateway and tested filesystem/network
isolation are still needed before untrusted real-agent work can run unattended.

## Experimental model gateway

`studio/model-gateway.mjs` is a tested building block, **not connected to the
main Compose preview or a real provider**. It accepts only `POST /v1/responses`, a single
configured model, JSON requests below 1 MiB, a required bounded
`max_output_tokens`, foreground requests only, and function tools. Explicit
`background: true` is rejected before a request consumes quota; this does not
guarantee that a provider stops work when a foreground request is interrupted.
It strips client headers and injects
the provider key read from `MODEL_GATEWAY_KEY_FILE`. It maintains a lifetime
request counter in `MODEL_GATEWAY_STATE`, incremented before forwarding and
preserved even for failed/uncertain requests. An exhausted counter rejects
requests; do not delete the state to bypass a limit. The model, request limit,
output limit and upstream endpoint are recorded with the quota; restarting with
different values fails closed. Each request also atomically checks the pinned
configuration and a non-negative integer counter before consuming quota; a
failed claim returns HTTP 429 without forwarding (database errors return 502).
Existing legacy quota databases without this
configuration are rejected without modification and require operator review.
An operator must pass `--initialize` once when creating a **new** quota database;
this refuses to overwrite an existing file. Normal starts refuse a missing or
empty database instead of silently creating a new allowance. The gateway cannot
detect a replaced or rolled-back valid database; doing so can change the effective
allowance. Protect and back up state. The mock-only fixture initializes its own
disposable state automatically and must not be used with real credentials.

There is **no gateway authentication**, so it must be reachable only from a
dedicated internal worker network. The key file and state directory must be
mounted only into the gateway, never the agent, and the agent must be unable to
reach any other network, host service, Docker socket or credential. The gateway
currently listens on all container interfaces and must not publish a host port.
It accepts requests only on the configured endpoint, but prompts can still send
data to the provider. These network and filesystem boundaries have not yet been
integrated or penetration-tested; do not use this gateway with real credentials.

For an isolated, disposable integration test with OpenCode 2.2.7 and a **mock**
upstream, run `sh studio/fixtures/test-gateway.sh` from the repository root. It
builds a separate image and two internal Docker networks; a fake secret is
mounted only in the gateway and fixture upstream. The worker checks that the
secret is not mounted, that the upstream is not resolvable, and that an external
IP is unreachable before running OpenCode through the gateway. The fixture uses
`/tmp` for quota state, so its limit does **not** survive container recreation.
Test containers are stopped but their networks and images are retained. Do not
use the fixture key or its fixed model for real work.

This proves the tested routes, not a complete isolation boundary: Docker's
internal bridges can expose host-side services depending on host configuration,
and privileged host or Docker users can inspect containers and secrets. OpenCode
has also been exercised through Cezar in this topology with a mock tracker and
model: `sh studio/fixtures/test-cezar-gateway.sh` creates a disposable fixture,
polls the mock Linear GraphQL service, binds the issue to an inbox receipt, and
runs Cezar's real OpenCode adapter through the gateway. The mock responds with
fixed text, so the planning run remains `waiting`; it does not create a plan,
complete the feature workflow, or publish a PR.

`sh studio/fixtures/test-full-cezar-gateway.sh` runs a separate, longer fixture:
scripted model responses drive real OpenCode sessions and tool calls through the
feature graph. A deliberately failing test and a simulated review finding cause
two fix attempts; the actual Node and Godot checks run, and the branch is
committed. An explicit `--approve` fixture step then pushes only to a disposable
bare repository and uses mock HTTP endpoints for the draft PR and Linear comment.
These scripted verdicts do not prove real model reasoning or review quality. Both
tests use no real tokens or credentials, stop their containers, and retain their
volumes and networks. Image builds download pinned OpenCode and Godot binaries;
the running fixture networks have no Internet route.

Docker address pools on this host were exhausted during a fixture rerun. The
network list showed many retained `studio-*` fixture networks, mostly with no
attached containers, plus other projects' networks. One older
`studio-cezar-gateway2` fixture was still running. No networks, containers or
volumes were removed or stopped as part of that investigation. An operator
should inspect ownership and approve any cleanup; never prune globally.

For the networkless-worker variant, run:

```sh
sh studio/fixtures/test-socket-fixture.sh
```

`compose.socket-fixture.yaml` gives Cezar/OpenCode `network_mode: none` and a
loopback relay to the gateway's shared Unix socket. A separate fixture tracker
uses the mock upstream. The test checks that the fixture key is absent from the
worker and an external connection fails with `ENETUNREACH`, runs the same
scripted feature and explicitly approved mock publication, then verifies that
the gateway quota survives a restart and the relay works afterwards. The cached
run completed successfully; fixture containers are stopped, but volumes and
networks are retained. The socket permits worker requests to the gateway: it
does not authenticate callers or prevent prompts from reaching the upstream.
The Cezar health check probes both Cezar and the relay's gateway listener using
a quota-free GET. It detects a dead relay but does not verify the model upstream,
quota availability, or caller identity. Docker marks failed health checks
unhealthy; it does not automatically restart an unhealthy running container.
This is not proof of filesystem, host, credential, or production isolation;
the provider, tracker and PR services are mocks, and the model is scripted.
Use a separate host/VM and independently test host, metadata-service, DNS and
egress isolation before considering real credentials.

The counter and output-token ceiling are **not a monetary cap**: input token
counts, model prices, retries, and provider billing are not verified here. A
provider-enforced project spend limit remains mandatory and may overshoot. The
gateway and OpenCode have only been tested against a mock HTTP fixture; streaming
failure recovery and the real provider have not been verified.
