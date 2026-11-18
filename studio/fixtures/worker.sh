#!/bin/sh
set -eu
test ! -e /run/secrets/fixture_key
node -e "require('dns').lookup('fixture-upstream',e=>{if(!e){console.error('upstream reachable');process.exit(1)} console.log('PASS upstream DNS isolated')})"
node -e "const s=require('net').connect({host:'1.1.1.1',port:443,timeout:1000});s.on('connect',()=>process.exit(1));s.on('error',()=>{console.log('PASS external network blocked');process.exit(0)});s.on('timeout',()=>process.exit(1))"
echo 'PASS fixture key not mounted in worker'
output=$(timeout 60s opencode --standalone run --model local/fixture 'Reply only FIXTURE_OK.')
printf '%s\n' "$output"
printf '%s\n' "$output" | grep -q 'FIXTURE_OK'
