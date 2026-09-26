#!/usr/bin/env bash
#
# Static-analysis gate: ruff (Python lint), vulture (Python dead-code), and
# knip (unused bridge TS exports/deps), run from the repo root.
#
# Why this script exists: none of the three tools has a first-class "just
# work in this repo" invocation.
#
#   - ruff and vulture are fine as `uvx` one-shots against the checked-out
#     tree; no venv or lockfile needed.
#   - knip needs a package.json to anchor its project root, and this repo
#     deliberately has none (see bridge/README.md: HT loads the extension via
#     symlinks, not npm). So this script copies `bridge/` and `knip.json`
#     into a throwaway temp directory with a stub `package.json` and runs
#     `bunx knip --production` there, then removes the temp directory. Only
#     the copy's report matters; nothing is written back into the checkout.
#
# All three tools run even if an earlier one fails or reports findings, so a
# single run surfaces every category of issue instead of stopping at the
# first. A short summary is printed at the end.
#
# Exit codes (mirrors scripts/typecheck-bridge.sh's convention):
#   0  all three tools ran and reported nothing
#   1  at least one tool reported findings, or failed to run
#   2  uvx or bunx is not available -> environment incomplete, not a code
#      failure; report as SKIPPED, not FAIL
set -euo pipefail

SKIP=2
say() { printf '%s\n' "$*" >&2; }

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT"

if ! command -v uvx >/dev/null 2>&1; then
	say "lint: SKIPPED — uvx not found (needed for ruff and vulture)."
	exit "$SKIP"
fi
if ! command -v bunx >/dev/null 2>&1; then
	say "lint: SKIPPED — bunx not found (needed for knip)."
	exit "$SKIP"
fi

failures=0
results=()

run_step() {
	# run_step <label> <command...>
	# Never lets a failing tool stop the other steps (set -e is in effect for
	# the rest of the script, so the failure is captured explicitly here).
	local label="$1"; shift
	local status=0
	say ""
	say "lint: running $label -> $*"
	if "$@"; then
		status=0
	else
		status=$?
	fi
	if [ "$status" -eq 0 ]; then
		results+=("PASS  $label")
	else
		results+=("FAIL  $label (exit $status)")
		failures=$((failures + 1))
	fi
	return 0
}

# --- ruff ---------------------------------------------------------------------
run_step "ruff" uvx ruff check .

# --- vulture --------------------------------------------------------------
vulture_targets=(orchestrator scripts)
[ -f "$REPO_ROOT/vulture_whitelist.py" ] && vulture_targets+=(vulture_whitelist.py)
run_step "vulture" uvx vulture "${vulture_targets[@]}" --min-confidence 80

# --- knip -------------------------------------------------------------------
# knip needs a package.json to anchor its project; this repo intentionally has
# none (HT loads bridge/ via symlinks, not npm), so build a throwaway probe
# workspace: copy bridge/ and knip.json, add a minimal stub package.json, run
# knip there, then remove it. Nothing is written back into the checkout.
knip_probe=$(mktemp -d 2>/dev/null) || knip_probe=""
if [ -z "$knip_probe" ]; then
	results+=("FAIL  knip (mktemp failed)")
	failures=$((failures + 1))
else
	trap '[ -n "${knip_probe:-}" ] && rm -rf "$knip_probe"' EXIT
	cp -R "$REPO_ROOT/bridge" "$knip_probe/bridge"
	cp "$REPO_ROOT/knip.json" "$knip_probe/knip.json"
	printf '{"name":"probe","private":true,"type":"module"}\n' >"$knip_probe/package.json"
	say ""
	say "lint: running knip -> bunx knip --production (in $knip_probe)"
	knip_status=0
	if (cd "$knip_probe" && bunx knip --production); then
		knip_status=0
	else
		knip_status=$?
	fi
	if [ "$knip_status" -eq 0 ]; then
		results+=("PASS  knip")
	else
		results+=("FAIL  knip (exit $knip_status)")
		failures=$((failures + 1))
	fi
	rm -rf "$knip_probe"
	trap - EXIT
fi

# --- summary -----------------------------------------------------------------
say ""
say "lint: summary"
for line in "${results[@]}"; do
	say "  $line"
done

if [ "$failures" -eq 0 ]; then
	say "lint: PASS — ruff, vulture and knip reported nothing"
	exit 0
fi

say "lint: FAIL — $failures of 3 step(s) reported findings or failed to run"
exit 1
