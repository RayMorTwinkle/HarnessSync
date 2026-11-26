#!/usr/bin/env bash
# Run inside a HarnessSync clone with the refactor dependencies installed.
set -euo pipefail
repo=$(git rev-parse --show-toplevel)
probe="$repo/docs/evals/artifacts/plan-reads.mjs"
out=$(mktemp -d "${TMPDIR:-/tmp}/hsync-replay.XXXXXXXX")
echo "Results: $out"
test -d "$repo/node_modules/tsx" || { echo "Run npm ci in the source repository first." >&2; exit 1; }

run_revision() {
  local label=$1 revision=$2 checkout="$out/$1/HarnessSync"
  mkdir -p "$out/$label"
  git clone --quiet --local --no-checkout "$repo" "$checkout"
  (
    cd "$checkout"
    git checkout --quiet --detach "$revision"
    ln -s "$repo/node_modules" node_modules
    node --import tsx "$probe" > "$out/$label.json"
    if [[ ${FULL_CHECKS:-0} == 1 ]]; then
      npm test > "$out/$label-tests.log" 2>&1
      npm run build > "$out/$label-build.log" 2>&1
    fi
  )
}
run_revision backup 008894c82cd4eb7075c53905f7b1d2fda82c699b
run_revision start 2dcab47a0606dbe5d34851892a0fd864cfdec25a
run_revision refactor 647664673a458c0d2be3a86046446566df225dc0
