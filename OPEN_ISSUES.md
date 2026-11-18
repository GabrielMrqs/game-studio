# Open issues

- **P0 — No proven spending or security boundary.** Before unattended runs,
  enforce and test per-run time/token/cost limits and isolate agents from secrets,
  main-branch writes, and network destinations. OpenCode shell permissions and
  Git worktrees alone are not an OS sandbox. A real planning probe reported
  `tokensUsed` 119,633 versus 15,878 input and 2,319 output; investigate the
  meaning and reliability of these counters before relying on cost accounting.
  A best-effort wall-clock/reported-token watchdog is available but cannot bound
  provider billing, request overshoot, agent access, or a dead watchdog.
  The owner must configure and verify a provider-enforced limit on a dedicated
  account/project. Offline Compose isolates networking but cannot call a model.
  The experimental model gateway has a persistent request counter and separates
  an injected credential. An isolated mock tracker → Cezar → OpenCode → gateway
  fixture executes the feature graph with scripted model responses. The socket
  variant tests a networkless worker, absent fixture key, quota persistence and
  relay recovery; production filesystem/host isolation and live provider billing
  are not verified. Gateway quota configuration is pinned to its database and
  normal startup refuses missing state, but replacement or rollback of a valid
  database can reset allowance. See
  `sh studio/fixtures/test-socket-fixture.sh`.
  An opt-in disposable Docker adversarial-process fixture verifies a synthetic
  host-only secret, read-only synthetic checkout, writable scratch and blocked
  host/external connections under `--network=none`. A scripted local model also
  drives an actual OpenCode shell tool through a separate gateway via a Unix
  socket. The gateway injects a synthetic key and enforces its request count;
  the tool cannot read that key or reach the tested host/external destinations.
  After quota exhaustion the fixture observes gateway rejection, no upstream
  request or tool execution, and continued rejection after gateway restart;
  its worker retries are terminated by the test. Request counts are not a
  provider-enforced monetary limit.
  A credential-free Cezar-managed feature run against the exhausted gateway
  stayed before commit for a ten-second observation, kept its Git HEADs
  unchanged, and refused publication without approval. The existing watchdog
  then requested a wall-clock cancellation and Cezar reported `cancelled`
  without scheduled auto-resume. The fixture verifies that the registered
  Cezar-owned OpenCode server and its process group have no live members after
  cancellation. A synthetic child launched by a fixture-only OpenCode wrapper
  created its own process group and continued writing a heartbeat after the
  watchdog cancelled the run. Killing the entire disposable networkless run
  container stopped that child's persisted heartbeat and yielded exit 137.
  A fixture-only external controller now checks the submitted receipt,
  accepted watchdog cancellation, full container ID, fixture labels and
  disabled restart policy before termination, preserving the receipt and
  cancellation record. A fixture-only SQLite binding outside the agent workspace
  records the run, container, token and termination phase; after a controller
  SIGKILL between Docker termination and acknowledgement, a new controller
  reconciles the exited container without sending a second kill. The fixture
  assumes protected host files and one controller, creates the binding only
  after the run exists, and does not cover earlier crashes or power loss.
  Tests now confirm a missing or incomplete binding and missing or ambiguous
  container inspection fail without signaling; an interruption after durable
  termination intent but before kill can retry against the verified fixture.
  A fixture-only pre-creation token reservation can discover a uniquely labelled
  unbound container after a creator SIGKILL, but only reports it for operator
  review. It does not prove Cezar run ownership, prevent label spoofing, or
  automatically reconcile or terminate that container.
  The startup guard blocks an on-disk worktree absent from even an existing
  run index, preserving the files for operator review; it cannot reconstruct
  or resume the missing run.
  A pinned Cezar dry-run API test also confirms that `POST /api/v1/runs`
  ignores a caller-supplied `id` and assigns its own. The current per-container
  fixture starts Cezar before that ID exists, so its pre-creation token alone
  cannot durably bind the real Cezar run before execution. A safe lifecycle
  needs a supported pre-execution binding or an independently enforced launch
  barrier, plus crash reconciliation; neither is established by this fixture.
  A dry-run integration test holds the create-run response at the client and
  observes a Cezar workflow step begin while the inbox receipt is still pending
  with no run ID. Pinned Cezar calls its queue pump before returning the run;
  a gate applied only after the response is too late. No supported paused
  create-run option was identified in the inspected API. An external model
  gateway alone is not an execution barrier for shell checks or agent processes.
  In the pinned package, `runCheckStep` directly spawns `bash` inside Cezar's
  own execution environment; no supported remote executor for all workflow
  processes was identified. A separate OpenCode launcher alone therefore cannot
  establish the requested control-plane boundary. A prototype must also contain
  checks and other process launches, and demonstrate the binding before any of
  them can execute; this has not been implemented.
  A credential-free negative control now confirms an actual Cezar `check` shell
  writes a fixture marker while the inbox receipt is still pending without a run
  ID. This test demonstrates the gap, not an independently enforced barrier.
  The pinned version also has a `gate.human` graph node, but it is a node after
  run creation, not a paused-create API: Cezar starts task naming before the
  queue, a different graph can omit the gate, and its `parkGraphNode` source
  says a restart settles an ask-parked run as failed for Continue. A graph gate
  alone is therefore not an independently enforced durable binding barrier.
  The pinned workspace configuration also interprets `resources.maxParallel: 0`
  as the fallback value `2`, rather than holding the queue; the contract requires
  values of at least one. A credential-free schema test checks this explicitly.
  Do not use a zero concurrency setting as a launch barrier.
  Process-group cleanup alone is insufficient, and the current worker does not
  implement automatic per-run container termination. Production per-run process
  isolation, container escapes, and real-provider failures remain unverified.
  An outage during a tool turn blocks completion; another session survives a
  short gateway restart without repeating its fixture tool, with quota retained.
  The fixture also kills and restarts OpenCode, then separately kills and
  restarts the same container with a persisted workspace; in each case the
  scripted model sees the prior tool result without rerunning it, and gateway
  quota remains intact. Host restart, power loss, and real-model recovery are
  not covered.
  The gateway and mock upstream run in the fixture test process, not production
  services. This is not the existing Compose security boundary or a test of
  remote model-access networking or container escape.
- **P0 — Feature graph unverified with real agents.** Exercise plan → tests →
  independent reviewer → fix → commit with controlled fixtures. Verify review
  failure, exhausted retries, test failure, and escalation all stop safely.
  A credential-free Cezar graph fixture now verifies planner `blocked` and
  persistent reviewer `changes` route to failed states without reaching the
  workflow feature-commit node or publisher. However, both scenarios produced
  Cezar autosave commits on the isolated worktree branch (`turn end` and/or
  `run finalize`). Cezar 0.20.0 does not gate these flushes on `CEZ_AUTOSAVE`.
  An explicit `CEZ_AUTOSAVE=0` credential-free test still observed
  `run finalize` after planner escalation and `turn end` after repeated review
  rejection. The pinned implementation only applies that setting to its
  periodic timer; no supported setting to disable these flushes was found.
  Therefore the stronger requirement of *no commits at all* after escalation
  or failed review is not met; do not treat the branch as approved or publishable.
  Tests verify the studio approval CLI and guarded publisher refuse those runs
  and their branches never reach the disposable remote. Even a failed run with
  all required success edges is refused. This does not restrict direct Git,
  Cezar cockpit/API operations or direct use of the lower-level publisher.
  The studio publication CLI now requires a human-reviewed full commit SHA and
  refuses a changed HEAD; the lower-level publisher pushes that exact SHA.
  Cezar's earlier automated review verdict still is not independently bound to
  that SHA, and the CLI cannot prove a human actually reviewed it.
  A credential-free fixture gates mock publication on human approval and an
  Ed25519 approval over a run ID and exact commit ID. It rejects changed
  commits, different runs and untrusted signatures, and does not let a valid
  signature override a failed workflow. This gate is not connected to the
  production reviewer: trusted key provisioning, isolated signing and reviewer
  independence are not established. The publication CLI now requires the
  signature and a separately configured trusted Ed25519 public key, and fails
  closed when the evidence is absent, untrusted or mismatched.
  A Linux bubblewrap fixture now signs an inspected Git commit from a
  read-only repository with network disabled and checks missing, untrusted and
  stale evidence against the fixture gate. Its reviewer is a scripted content
  check, not OpenCode or evidence of production key isolation.
  A separate opt-in Docker fixture now drives actual OpenCode through a scripted
  model to inspect a commit on a read-only mount; its host-side fixture signer
  signs after observing the matching tool result, and the fixture gate rejects
  absent, untrusted and stale evidence. The deterministic model is not a real
  independent review; no production signer or trust provisioning exists.
  The fixture uses scripted runner responses, not independent real reviewers.
  A controlled model now drives real OpenCode sessions through the complete
  graph, but real model behavior, escalation and review independence remain unverified.
- **P0 — Abrupt Cezar recovery can lose worktree metadata.** A disposable
  `SIGKILL` test during an active check retained the run and worktree on disk,
  but Cezar's restarted API reported the run as running without a worktree path.
  Investigate and reconcile before resuming; do not treat `running` alone as
  proof of progress or publish from a provisional receipt. Detached OpenCode
  child cleanup and host/power-loss recovery have not been verified end to end.
  A Linux fixture verifies startup cleanup after killing an actual Cezar owner of
  a modified mock server, leaving an unregistered server alone. An earlier
  normal-mode submission timed out: the bundled mock starts a server rather
  than answering Cezar's `auth list` probe. The isolated fixture bypasses that
  probe with `CEZ_AGENT_MODELS_LOCKED=1`, not a production recommendation.
  Real-agent cleanup remains unproven. Cezar's startup sweep is skipped in
  dry-run mode and depends on its registry and /proc.
  Cezar 0.20.0 updates the worktree path in its in-memory run record and saves
  the run index on a one-second debounce, consistent with the observed window;
  this does not prove the sole cause. The status command warns about a standard
  on-disk worktree missing from an active API record. The optional watchdog
  rechecks and requests cancellation, but can race normal worktree creation and
  cannot prevent execution before it detects the mismatch.
  An integrated Cezar/OpenCode container restart reproduced a changed OpenCode
  session ID on an active run when starting Cezar without the guard, risking
  duplicate execution. In pinned Cezar 0.20.0, `RESUMABLE_BACKENDS` excludes
  OpenCode, and its V2 runner opens a new session even if asked to resume.
  On 2026-11-17, the npm registry still reported 0.20.0 as latest; this
  investigation found no documented custom-runner hook in the published
  package. A disposable unguarded negative control reproduced session
  replacement and a second tool attempt after the original session completed;
  an exclusive fixture write prevented the repeated side effect. Supporting
  Cezar-to-OpenCode V2 continuation requires upstream support or a separately
  reviewed maintained fork; do not patch installed dependencies or disable
  the guard in deployment.
  Upstream [PR #1820](https://github.com/open-mercato/cezar/pull/1820),
  observed open on 2026-11-17, proposes reopening OpenCode V2 sessions for
  Continue. Its diff does not change the workflow restart resumable-backend
  gate, and its proposed missing-session fallback starts a fresh session.
  Its author notes the end-to-end OpenCode continuation was not verified.
  It is not evidence of safe interrupted-workflow recovery; if upstream lands
  a compatible fix, repeat the guarded crash and duplicate-side-effect fixture
  before considering an upgrade.
  A separate Symphony/OpenCode candidate was evaluated at commit
  `756b515840e138aa941e1ab6b5bfc2bf504cbef9`: 24 upstream mocked tests
  passed offline, including use of a recorded session ID. Its recovery tests
  also show a first turn with no stored session is rerun, so it is not a
  verified fix for duplicate side effects. Its license files conflict and its
  network/credential boundary and approval-gated publication need review.
  See `AUDIT.md`; no orchestrator switch has been made.
  A credential-free fixture independently continued the recorded OpenCode session
  with the supported CLI while Cezar remained blocked; its model saw the prior
  tool result, no tool or receipt was duplicated, and quota continued. This
  does not resume Cezar's workflow or establish a safe production procedure.
  The base mock Compose startup now blocks all persisted
  queued/running/waiting and auto-resuming failed runs before launching Cezar,
  even when the worktree metadata is valid. Operator review is required; this
  deliberately sacrifices automatic recovery. It also refuses review runs
  without a recorded path and blocks malformed
  indexes or missing indexes when state exists. It does not validate the full
  run schema. It verifies the standard path, Git registration and recorded
  branch for recoverable runs, but not worktree contents. This conservative check can block normal
  queued runs and does not stop already-running children,
  assumes no concurrent writer, and is not applied to direct Cezar invocations
  or the separate socket/gateway fixtures.
  A networkless base Compose test confirmed the startup command refuses a
  seeded missing-path index without changing it; the preceding SIGKILL itself
  retained the path in that particular run. Real crash-state and deployment
  recovery remain unverified end to end. A previous networkless Compose test
  accepted a matching registered worktree before the stricter active-run
  guard and refused a seeded wrong path without modifying the index or worktree.
  The integrated guarded fixture preserves the original run/session binding,
  inbox receipt and quota after restart, but does not resume execution.
  A separate networkless test of the actual base Compose worker and inbox
  confirmed identical ideas produce one receipt and one mock run, publication
  without approval is refused, and the worker refuses to restart with the
  waiting run after a graceful stop. This does not test a real agent, provider
  spending, production isolation, or crash recovery.
  `studio/inspect-recovery.mjs` provides a read-only persisted-state view and
  flags marker-only receipts, but does not verify OpenCode's session database
  or create an atomic snapshot; operators must stop writers first. The
  credential-free container fixture separately checks a private copy of the
  actual stopped OpenCode V2 database and WAL: its session ID, directory and
  completed tool result match Cezar, and source bytes remain unchanged. This
  uses a version-specific internal schema, not a production inspection API.
- **P1 — Some inbox submissions need manual recovery.** A uniquely marked run
  recovered without the original response is provisional and cannot be published;
  missing, duplicate, pruned and legacy markerless results remain pending.
  Previously auto-recovered submitted receipts cannot be distinguished from direct
  submissions and need operator audit. Conflicting concurrent outcomes are blocked
  for manual investigation; new conflicts retain both observed run IDs, but older
  conflicts may not. An operator can quarantine a two-ID conflict without choosing
  a run; it remains blocked from publication and retry. The command can confirm only an unambiguous
  provisional receipt and relies on a manually verified stopped inbox. Cezar's run creation endpoint does not
  supply an idempotency key; never blindly resubmit ambiguous receipts.
- **P1 — Linear ingestion is not live-verified.** Validate GraphQL schema,
  pagination, permissions, rate limits, webhook proxy and recovery with a real
  workspace; support comments, attachments, and durable issue status updates.
  Conflicting or symlinked handoff files remain pending for manual investigation;
  filesystem checks are not a security boundary against concurrent tampering.
- **P1 — Publishing is manual and not live-verified.** A durable issue/run
  binding and Cezar outcome gate exist, but test GitHub/Linear authentication,
  crash recovery, and a real agent end-to-end run; recorded outcomes do not
  independently attest model review quality or prevent same-user tampering.
  An operator can verify an existing feature ref for `pushing`, record an
  existing matching draft for `claimed` or `pr_pending`, or mark
  `comment_pending` done after matching PR and comment evidence. New receipts
  record the PR base; older baseless receipts require manual handling. A PR found during `claimed` may
  predate the claim. Missing or ambiguous remote evidence remains manual.
- **P1 — Compose is mock-only.** The isolated preview has persistent volumes,
  health checks and resource ceilings, but no real OpenCode, Linear, credentials,
  model budget, or trusted production deployment. Host networking and the
  unauthenticated cockpit require a trusted machine.
- **P1 — Game prototype needs production art and broader verification.** The
  standalone slice has placeholder SVG art, headless smoke tests and an initial
  scene screenshot workflow, but no comprehensive visual review or export build.
  Evaluate Popochiu integration on Godot 4.3;
  the mock-only Compose image does not include Godot, so feature runs there
  fail the required game gate rather than skipping it.
