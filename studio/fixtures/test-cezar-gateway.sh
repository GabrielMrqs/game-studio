#!/bin/sh
set -eu
project="studio-cezar-fixture-$$"
compose() { docker compose -p "$project" -f compose.gateway-fixture.yaml "$@"; }
cleanup() { compose stop >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
compose up -d --build --wait cezar
compose exec -T cezar sh -c 'test ! -e /run/secrets/fixture_key && test ! -e /project/studio/fixtures/fixture-key.txt && echo "PASS fixture key absent from worker"'
compose exec -T cezar node -e "require('dns').lookup('fixture-upstream',e=>{if(!e)process.exit(1);console.log('PASS upstream DNS isolated')})"
compose exec -T cezar node -e "const s=require('net').connect({host:'1.1.1.1',port:443,timeout:1000});s.on('connect',()=>process.exit(1));s.on('error',()=>{console.log('PASS external network blocked');process.exit(0)});s.on('timeout',()=>process.exit(1))"
compose run --rm --no-deps tracker-ingest
compose exec -T -e CEZ_API_URL=http://127.0.0.1:14321 -e STUDIO_STATE=/handoff cezar node studio/inbox.mjs --once
compose exec -T cezar node -e '
const fs = require("fs");
(async () => {
  for (let i = 0; i < 100; i++) {
    const runs = await (await fetch("http://127.0.0.1:14321/api/v1/runs")).json();
    const run = runs[0];
    if (run && ["waiting", "done", "failed", "cancelled"].includes(run.status)) {
      const log = fs.readFileSync(`/project/.ai/cezar/runs/${run.id}.ndjson`, "utf8");
      const db = new (require("node:sqlite").DatabaseSync)("/handoff/inbox.sqlite", { readOnly: true });
      const receipt = db.prepare("SELECT source_id, run_id FROM receipts").get();
      db.close();
      if (run.status !== "waiting" || run.steps[0]?.backend !== "opencode" || !log.includes("FIXTURE_OK") || receipt?.source_id !== "12345678-1234-1234-1234-123456789012" || receipt.run_id !== run.id) throw Error("Cezar did not receive the expected bound mock response");
      console.log(`PASS mock Linear → inbox → Cezar → OpenCode → gateway → mock upstream: ${run.status}, ${run.steps[0].backend}`);
      return;
    }
    await new Promise(done => setTimeout(done, 100));
  }
  throw Error("Cezar run did not reach the expected state");
})().catch(e => { console.error(e.message); process.exit(1); });'
