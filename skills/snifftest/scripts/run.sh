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
#   SNIFFTEST_SEND=…     already in the environment, put there by the user or by
#                        a CI job. It names the destinations it answers for, and
#                        `1` is the shorthand for the one `check` uses. Read
#                        here, never written here.
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

# What is left after this loop is the path list, and only the path list.
#
# --judge is this script's own word and not the tool's, so it is dropped. A `--`
# the caller wrote is dropped too, because this script places its own, once, in
# the right place: immediately before the paths. Without that separator a file
# named `-notes.md` reaches the checker looking like an option it does not have,
# and the run fails on the name of a file rather than on its prose.
paths=""
separated=0
for argument in "$@"; do
  case $argument in
    --judge)
      continue
      ;;
    --)
      if [ "$separated" = "0" ]; then
        separated=1
        continue
      fi
      ;;
  esac
  paths="$paths
$argument"
done

# --- which snifftest, and where it is run from -------------------------------
#
# An agent points this script at a repository somebody else wrote, so the tree
# being checked is hostile input and two ordinary conveniences hand it a shell.
#
# A package manager asked for `snifftest@<version>` while standing in a
# repository runs that repository's own `node_modules/snifftest` and never
# reaches a registry. Measured offline, with the registry pointed at a dead
# port: standing inside such a checkout ran the committed binary; standing
# outside it refused to connect and ran nothing. So the fetch is made from a
# scratch directory, and `--root` tells the checker which tree it is about.
#
# `command -v snifftest` reaches a checkout's own `node_modules/.bin`, which is
# on PATH whenever a package script or a hook manager put it there. A candidate
# that resolves inside the tree is refused for the same reason.

root=$(pwd -P)

scratch=$(mktemp -d 2>/dev/null || mktemp -d -t snifftest) || {
  echo "snifftest: no temporary directory available." >&2
  exit 2
}
trap 'rm -rf "$scratch"' EXIT HUP INT TERM

inside_root() {
  candidate=$(cd "$(dirname "$1")" 2>/dev/null && pwd -P) || return 1
  case $candidate in
    "$root" | "$root"/*) return 0 ;;
  esac
  return 1
}

run_snifftest() {
  if [ -n "${SNIFFTEST_BIN:-}" ]; then
    (cd "$scratch" && "$SNIFFTEST_BIN" "$@")
    return $?
  fi

  found=$(command -v snifftest 2>/dev/null) || found=''
  if [ -n "$found" ] && inside_root "$found"; then
    echo "snifftest: ignoring the snifftest inside this tree; it is the code being checked." >&2
    found=''
  fi

  if [ -n "$found" ]; then
    (cd "$scratch" && "$found" "$@")
  elif command -v bunx >/dev/null 2>&1; then
    (cd "$scratch" && bunx "snifftest@$SNIFFTEST_VERSION" "$@")
  elif command -v npx >/dev/null 2>&1; then
    (cd "$scratch" && npx --yes "snifftest@$SNIFFTEST_VERSION" "$@")
  else
    echo "snifftest: no snifftest, bunx or npx on PATH." >&2
    return 2
  fi
}

set -- check

# SNIFFTEST_SEND names the destinations it answers for, and `1` is the
# shorthand for the one `check` uses. Anything that names something is a
# request for the judgment pass; the tool still decides whether the answer
# actually covers where this run would send.
case "${SNIFFTEST_SEND:-}" in
  "" | 0) asked_to_send=0 ;;
  *) asked_to_send=1 ;;
esac

if [ "$judge" = "0" ] && [ "$asked_to_send" = "0" ]; then
  set -- "$@" --dry-run
fi

# The run happens outside the tree, so the tree is named rather than stood in.
set -- "$@" --root "$root"

# Newline is the only separator, so a path with a space in it survives.
old_ifs=$IFS
IFS='
'
# shellcheck disable=SC2086 -- the split is the point, and IFS is a newline.
set -- "$@" -- $paths
IFS=$old_ifs

run_snifftest "$@"
