#!/bin/sh
set -eu
project="studio-socket-fixture-$$"
compose() { docker compose -p "$project" -f compose.socket-fixture.yaml "$@"; }
cleanup() { compose stop >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
compose up -d --build --wait cezar
compose exec -T cezar sh -c 'test ! -e /run/secrets/fixture_key && test ! -e /project/studio/fixtures/fixture-key.txt && echo "PASS key absent from networkless worker"'
compose exec -T cezar node -e "const s=require('net').connect({host:'1.1.1.1',port:443,timeout:1000});s.on('connect',()=>process.exit(1));s.on('error',e=>{if(e.code!=='ENETUNREACH')process.exit(1);console.log('PASS networkless worker: '+e.code);process.exit(0)});s.on('timeout',()=>process.exit(1))"
compose run --rm --no-deps tracker-ingest
compose exec -T -e CEZ_API_URL=http://127.0.0.1:14321 -e STUDIO_STATE=/handoff -e STUDIO_WORKFLOW=studio-feature cezar node studio/inbox.mjs --once
compose exec -T cezar node studio/fixtures/wait-full-workflow.mjs
compose exec -T cezar node studio/fixtures/publish-full-fixture.mjs --approve
before=$(compose exec -T gateway node -e "console.log(new (require('node:sqlite').DatabaseSync)('/quota/quota.sqlite',{readOnly:true}).prepare('SELECT used FROM quota').get().used)")
test "$before" -gt 0
compose restart gateway
after=$(compose exec -T gateway node -e "console.log(new (require('node:sqlite').DatabaseSync)('/quota/quota.sqlite',{readOnly:true}).prepare('SELECT used FROM quota').get().used)")
test "$before" = "$after"
printf 'PASS gateway quota persisted across restart: %s requests\n' "$after"
compose exec -T cezar node studio/fixtures/socket-health.mjs
printf 'PASS socket fixture health after gateway restart\n'
compose exec -T cezar node -e "fetch('http://127.0.0.1:18080/v1/responses',{method:'POST',body:JSON.stringify({model:'fixture-model',max_output_tokens:1,input:[]})}).then(async r=>{if(!r.ok||!(await r.text()).includes('FIXTURE_OK'))process.exit(1);console.log('PASS socket relay recovered after gateway restart')}).catch(()=>process.exit(1))"
