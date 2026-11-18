#!/bin/sh
set -eu
project="studio-full-fixture-$$"
compose() { docker compose -p "$project" -f compose.gateway-fixture.yaml "$@"; }
cleanup() { compose stop >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
compose up -d --build --wait cezar
compose exec -T cezar sh -c 'test ! -e /run/secrets/fixture_key && test ! -e /project/studio/fixtures/fixture-key.txt'
compose run --rm --no-deps tracker-ingest
compose exec -T -e CEZ_API_URL=http://127.0.0.1:14321 -e STUDIO_STATE=/handoff -e STUDIO_WORKFLOW=studio-feature cezar node studio/inbox.mjs --once
compose exec -T cezar node studio/fixtures/wait-full-workflow.mjs
compose exec -T cezar node studio/fixtures/publish-full-fixture.mjs --approve
