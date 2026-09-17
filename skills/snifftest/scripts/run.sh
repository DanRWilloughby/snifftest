#!/bin/sh
#
# Sniff Test, run from the Claude Code skill.
#
# Usage:
#   sh run.sh [--judge] [--] <paths...>
#
# By default this runs the countable rules only. Nothing leaves the machine and
# nothing is spent. That is the pass an agent may run freely.
#
# The judgment rules send the draft to a model, so they are the user's call.
# Two things can ask for them, and neither of them is this script:
#
#   --judge              the caller asked for the judgment pass. The tool still
#                        decides whether it may send: it asks, or exits 3 when
#                        it cannot ask, unless the user already said yes on this
#                        machine and it remembered.
#   SNIFFTEST_SEND=1     already in the environment, put there by the user or by
#                        a CI job. Read here, never written here.
#
# This script never answers the sending question for anyone. It adds no flag
# that skips the question, and it does not touch the key, which the tool reads
# from the environment by itself.
#
# Environment
#   SNIFFTEST_VERSION=…  the version fetched when snifftest is not installed
#   SNIFFTEST_BIN=…      an absolute path to the executable to run

set -u

# Pinned. A floating version would change what runs under someone else's draft
# without them asking for it.
SNIFFTEST_VERSION="${SNIFFTEST_VERSION:-0.1.0}"

judge=0
for argument in "$@"; do
  [ "$argument" = "--judge" ] && judge=1
done

if [ "$judge" = "0" ] && [ "${SNIFFTEST_SEND:-0}" != "1" ]; then
  set -- --dry-run "$@"
fi

# --judge is this script's own word, not the tool's. Drop it before handing the
# rest of the arguments over.
args=""
for argument in "$@"; do
  [ "$argument" = "--judge" ] && continue
  args="$args
$argument"
done

run_snifftest() {
  if [ -n "${SNIFFTEST_BIN:-}" ]; then
    "$SNIFFTEST_BIN" "$@"
  elif command -v snifftest >/dev/null 2>&1; then
    snifftest "$@"
  elif command -v bunx >/dev/null 2>&1; then
    bunx "snifftest@$SNIFFTEST_VERSION" "$@"
  elif command -v npx >/dev/null 2>&1; then
    npx --yes "snifftest@$SNIFFTEST_VERSION" "$@"
  else
    echo "snifftest: no snifftest, bunx or npx on PATH." >&2
    return 2
  fi
}

# Newline is the only separator, so a path with a space in it survives.
old_ifs=$IFS
IFS='
'
# shellcheck disable=SC2086 -- the split is the point, and IFS is a newline.
set -- check $args
IFS=$old_ifs

run_snifftest "$@"
