# Deferred-start barrier investigation

Cezar 0.20.0 has a deferred-start lifecycle distinct from the ordinary
`POST /api/v1/runs` path. `fireDeferred` writes a generated run ID into the
automation definition before calling its launcher. The credential-free
`deferred-barrier.test.mjs` exercises the actual lifecycle with a **fixture
launcher**: it observes the ID on disk, refuses a missing sandbox binding, and
checks that an ambiguous failure is not launched again automatically.

The real server has no demonstrated supported external launch hook between
reservation and `startRun`, whose naming and queue pump can start processes. The stored
`deferredBinding` identifies model accounts, not a container or worktree. The
definition is replaced using write-and-rename without an explicit filesystem
sync, so this test does not establish durability across power loss. Creating
a deferred task also enables a schedule: a future time is not a fail-closed
manual-only gate.

A candidate design would first establish a uniquely identified per-run execution
environment and persist its ownership against a single deferred task. A trusted
pre-launch check would then verify the reserved Cezar run ID, task identity and
environment identity before allowing **any** naming, agent, or shell process.
It must fail closed on an absent or inconsistent binding, stop the entire run
environment on cancellation, and refuse automatic replay after an uncertain
launch. Atomic, power-loss-safe persistence and an operator-controlled
manual-only launch must be established separately.

This check must be enforced outside agent control and integrated at a supported
pre-launch seam. The fixture callback is not that seam. Cezar autosave commits
also still need to be prevented or isolated until validation and review. No
real workflow should be launched on the basis of this test.

The credential-free `feature-e2e.test.mjs` failure fixture now additionally
checks that the observed autosaves are on `cez/` branches and leave its `main`
at the original commit. This is fixture-level quarantine, not a guarantee that
a production feature branch cannot contain an unreviewed autosave or that a
real agent cannot access another branch.

`autosave-isolation.test.mjs` tests a narrower OS-enforced quarantine: in a
networkless bubblewrap fixture, the baseline repository is read-only and the
actual Cezar autosave function commits only in a separate, writable disposable
repository. The test verifies the baseline commit and file remain unchanged.
It does not run a Cezar workflow or establish safe transfer of reviewed changes
to a feature branch; it is not yet wired into the studio.

`cezar-shell-barrier.test.mjs` starts actual Cezar in a disposable bubblewrap
environment with auto-naming disabled and a read-only fixture `bash` wrapper.
The wrapper uses the `CEZ_RUN_ID` Cezar supplies to checks. A check waits while
its permit is missing or has the wrong value, then runs after the host writes
the matching permit. The test also checks that the wrapper cannot write the
permit directory. This is a **fixture-only shell gate**: it does not bind a
run to a container durably, gate OpenCode or naming, prevent other executables
or PATH changes from bypassing it, cover recovery, or integrate the autosave
quarantine. Do not use it to authorize a real run.

The same test mounts a synthetic `opencode.db` in the shared worker HOME.
After permit release, an actual Cezar shell check reports that it can read
that file despite its mode being 0600. The file contains no credentials and
this test does not inspect a real database or establish where real credentials
are stored. It does show that a shared HOME cannot protect agent authentication
from checks running as the same user. A live design must isolate the agent's
authentication from check processes and verify that boundary with synthetic
secrets before mounting credentials.

A second credential-free case runs the actual Cezar check inside a nested
Bubblewrap sandbox with a separate HOME and no agent-home mount. The launcher
confirms the synthetic file exists; the check cannot read it through the agent
path, its own HOME, or `/proc/1/root`. The shared-HOME negative control still
shows access. This is a fixture wrapper, not enforcement for every check
launch; it does not demonstrate real OpenCode authentication, protect the
parent Cezar process from credentials, or resolve the binding and bootstrap
blockers. Do not mount real credentials based on this test.

`cezar-opencode-barrier.test.mjs` is a credential-free combined fixture. One
actual Cezar run executes a check, then starts its OpenCode adapter, with
`CEZ_AUTONAME=0`. Separate read-only wrappers check `CEZ_RUN_ID` and
`CEZ_TASK_ID` against per-stage permits before starting the check shell and
real OpenCode binary. A controller subprocess writes the run ID and bubblewrap
PID/start-time into SQLite with `synchronous=FULL`, then is killed before
issuing a permit. The parent reopens that record and checks the PID identity
before releasing the gates. The fixture explicitly calls Cezar's autosave
function from the check in a scratch clone; its read-only baseline remains
unchanged. A synthetic child started by the fixture wrapper in a separate
session continues writing a heartbeat after Cezar accepts cancellation, but
the heartbeat stops after the sandbox launcher exits.
In a second fixture, after Cezar persists a running worktree but before the
OpenCode permit is released, the sandbox is killed. The existing startup guard
then refuses restart, the fixture binding is preserved, and OpenCode has not
been launched.

This is **not** a production binding or recovery procedure. The run has already
been created when the controller records ownership; the wrappers are PATH and
binary conventions rather than an independent enforcement boundary. PID
identity is not proof of container membership, and the fixture assumes the
host controller and permit directory are protected. The explicit autosave is
not evidence of a normal model turn or safe reviewed-change transfer. The
fixture does not authenticate a provider, run a real model turn, establish
power-loss durability, prove all possible descendants stopped, or test restart
reconciliation or continuation. Guard refusal is not recovery. Its private HOME has no host credentials; its network is shared
with the host. Do not use it to authorize a real run.

An additional negative control in that fixture submits a graph selecting a
different runner. The actual Cezar process starts its harmless fixture binary
without any permit: the OpenCode/Bash wrappers do not cover all agent launch
paths. The test uses `CEZ_DRY_RUN=1` and no real provider. Cezar's check-secret
schema does refuse `PATH` as a secret name or alias, but that does not fix this
alternate-runner bypass or turn PATH-based wrappers into a security boundary.

`fixtures/exec-gate.c` and `exec-gate.test.mjs` are an x86-64 Linux-only,
credential-free seccomp user-notification experiment. A supervisor can hold
the tested `execve` and `execveat` calls irrespective of executable path;
killing the supervisor while a call is held did not execute the test command.
This is **not production code**: it begins open for bootstrap, does not bind
ownership, authenticate control, contain already-running processes, or handle
recovery. It has not been audited as a security boundary.

`cezar-exec-gate.test.mjs` applies that coarse gate to actual Cezar after
startup, then holds all execs before submitting a task. The POST timed out and
the persisted run index was empty; the held executable was `/usr/bin/git`.
A second fixture permits only `/usr/bin/git` and `/usr/lib/git-core/git` while
holding other execs. Cezar returns a run ID; the fixture records that ID and
the bubblewrap child PID, PID start time and namespace in SQLite with
`synchronous=FULL`, syncs the containing directory, and rechecks process
identity. It then allows a held check shell, verifies an alternate fixture
runner remains held, and finally releases that runner. Both fixtures use actual
Cezar, but the alternate runner is simulated and no model is authenticated.

This is still **not a safe bootstrap allowlist**. The supervisor checks a
pathname in another process's memory, then uses seccomp `CONTINUE`; the
pathname can change between inspection and execution. It does not inspect Git
arguments, inherited file descriptors, hooks, configuration, or all side
effects, and initially runs open for bootstrap. The PID-namespace record has
not been tested against adversarial processes or power loss. The controller,
recovery, autosave quarantine and inbox are not integrated. No real task should
be launched with this experiment.

A subsequent fixture opened a chunked POST and sent only the first byte while
the exec gate was open, waited 300 ms, held all execs, then sent the rest of
the task body. The request still timed out with `/usr/bin/git` held and no
persisted run. This rules out that particular timing strategy in the fixture;
it does not identify which server phase requested Git or prove all possible
preflight timing strategies fail. It did not release the blocked request.

The same kernel fixture tests the **actual deferred-start HTTP API** rather
than an injected launcher. It creates a far-future disposable deferred task
while the fixture gate is open, holds all execs, and manually requests launch.
Cezar writes a reserved run ID while Git remains held. The fixture syncs the
definition file and its directory, records the ID with bubblewrap's child PID,
start time and PID namespace in SQLite with `synchronous=FULL`, syncs the
binding directory, and asks the supervisor to verify before releasing execs.
The check explicitly calls Cezar's autosave function in a scratch repository;
the read-only baseline remains unchanged. A **simulated** alternate runner then
runs. In a second case the supervisor is killed before release; the reserved ID
and binding remain, neither check nor agent runs, and the startup guard refuses
restart specifically because the deferred launch is still `launching`. The
guard also refuses reserved run IDs and stored manual launch requests even when
no run index exists; a focused test verifies state remains unchanged.

Cezar's actual deferred-start API creates the task enabled, and its ordinary
automation pause endpoint returns HTTP 409 for that task. The fixture verifies
both facts; a far-future timestamp is therefore not a paused-create guarantee.
The startup guard now also refuses *any* enabled deferred task, even before a
run ID is assigned. This is deliberately conservative and can block an
otherwise normal future task; it does not pause the live scheduler.

A further fixture prepares a disabled, already-due deferred definition **before**
starting Cezar, using Cezar 0.20.0's internal `AutomationStore` and
`resolveDeferredExecution`. `ScheduleRunner.dueAt` returns `null`, the startup
guard permits the disabled pending record, and no run is observed before the
manual API call. The manual call reserves the ID under the universal exec hold;
after fixture binding verification, the check and simulated runner execute in
the scratch repository. This also passes in the private network namespace.
Cezar changes the definition to `enabled: true` when the manual launch is
claimed. A separate fixture kills the supervisor after that claim but before
release: neither the check nor simulated agent runs, the binding and reserved
ID remain, and the startup guard refuses the persisted state. This also passes
in the private network namespace.

Another private-network fixture releases the bound run and lets a simulated
agent append one marker before killing the supervisor. With the active run and
worktree persisted, the startup guard refuses restart; the one marker and the
binding remain. This checks refusal after a side effect, not replay-safe
continuation: the fixture deliberately does not bypass the guard or restart
Cezar.

This is a pinned-internal-API experiment, not a supported paused-create API or a
production command. Its brief observation is not proof that a worker cannot be
started by another local request, the initial preparation and gate bootstrap
are not yet a verified exclusive protocol, and an interrupted launch still
requires operator investigation. No real model or live Cezar feature was run.

This is not yet a safe supervised launcher. The gate starts open during
bootstrap, the far-future deferred task is enabled, and the fixture uses a
shared host network and a mock runner. There is no authenticated, exclusive
control channel or verified guarantee that no preexisting or external request
can launch while the gate is open. The sync-and-reread sequence has not been
proven atomic against concurrent writers or power loss. Autosave quarantine
is fixture-only and uses an explicit call rather than a real model turn; inbox
submission and reviewed-change transfer are not integrated. Startup refusal is
not reconciliation. No real Cezar workflow should be launched on this basis.

`cezar-private-network.test.mjs` repeats the actual deferred-start release and
interruption fixtures inside a fresh unprivileged user and network namespace,
with loopback enabled only there. A listener on host loopback was unreachable;
the test verifies Cezar shares the controller's private network namespace and
not the host's. The kernel-gate test also checks that the supervisor's control
descriptor is not inherited by its test shell or Python child; the Cezar check
fixture likewise confirms descriptor 3 is absent.
The fixture supervisor rejects a release while already open, and a disconnected
controller while held terminates its child without releasing the test exec.
Its unverified mode still accepts `R` after a hold and its fixture-only `G`
and `B` commands deliberately allow pathname-based execs.

In the separate **verified fixture mode**, the supervisor invokes
`fixtures/verify-exec-binding.mjs` before releasing. The verifier checks a
single private SQLite binding against the actual deferred automation's one
reserved ID, live PID start time and PID namespace, sandbox ancestry, and
the PID namespace of each already-pending exec. Missing, ambiguous, mismatched,
stale, insecure-mode and symlinked fixture evidence is refused. `G` and `B` are
refused in this mode. The actual Cezar deferred fixture checks missing binding,
wrong run ID and wrong namespace cannot release; a valid fixture binding can.
`verify-exec-binding.test.mjs` also checks a pending exec in another PID
namespace is refused. After release, the supervisor retains the verified PID
namespace and denies later execs from a different one. `exec-namespace.test.mjs`
uses an actual nested PID namespace and confirms its later exec fails with
`EPERM`. This restrictive fixture policy may also block legitimate nested
namespace-based tests.

This is not an independently authorized production protocol. It assumes the
helper, context, controller and host-owned files cannot be changed by a
same-user host process, uses path-based file checks with possible races, and
does not prove the deferred record cannot change between verification and
release. Nor does it prevent preexisting processes during open bootstrap,
provide a bounded verifier, or
reconcile crash state. Do not use it for a live task.

This is still fixture evidence, not an authenticated production control
channel: same-user host access and other attack paths were not assessed, and
the exec supervisor starts open for bootstrap. The networkless namespace has
no demonstrated route to a real model. The existing mock gateway is not a
verified real-provider or OAuth integration; do not add real credentials to it
or silently return to host networking.
