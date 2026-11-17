#!/bin/sh
set -eu
project="studio-gateway-test-$$"
cleanup() { docker compose -p "$project" -f compose.gateway-fixture.yaml stop >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
docker compose -p "$project" -f compose.gateway-fixture.yaml build
docker compose -p "$project" -f compose.gateway-fixture.yaml up -d gateway fixture-upstream
docker compose -p "$project" -f compose.gateway-fixture.yaml run --rm --no-deps worker
