#!/usr/bin/env bash
#
# Strict typecheck for the orchestrator bridge extension.
#
# Why this script exists: the extension is loaded by HUMAIN Terminal from this
# skill repo, so the repo has no package.json, node_modules, or tsconfig of its
# own. The plan's original fallback command
#
#   bunx tsc --noEmit --strict ... *.ts
#
# therefore always failed with cascading TS2307s (it cannot resolve
# `@humain/terminal`, `typebox`, `node:*`, or `bun:test`), which made the
# typecheck gate unrunnable and got reported as a code failure. This script
# builds a tsconfig that points at the *installed* HT workspace and runs tsc
# against it, so the gate is reproducible instead of environment-dependent.
#
# Exit codes are deliberately three-way so an automated QA agent can tell
# "broken code" apart from "wrong machine":
#   0  typecheck clean
#   1  type errors found  -> a real failure, fix the code
#   2  cannot run here    -> environment incomplete, report as SKIPPED not FAIL
#
# Scope: bridge/extensions/orchestrator/*.ts only. bridge/extensions/
# cross-review-demo.ts has 6 known pre-existing diagnostics documented as
# baseline debt in bridge/extensions/orchestrator-README.md; it is out of scope
# so this gate stays at zero and any new error is unambiguous.
#
# Override discovery with HUMAIN_TERMINAL_ROOT=/path/to/humain-terminal.
set -uo pipefail

SKIP=2
say() { printf '%s\n' "$*" >&2; }

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TARGET_DIR="$REPO_ROOT/bridge/extensions/orchestrator"
[ -d "$TARGET_DIR" ] || { say "typecheck: missing $TARGET_DIR"; exit "$SKIP"; }

# --- locate the installed HT workspace ---------------------------------------
# Marker is the built type declaration the extension imports as @humain/terminal.
HT_MARKER="packages/coding-agent/dist/index.d.ts"
ht_root=""
if [ -n "${HUMAIN_TERMINAL_ROOT:-}" ]; then
	# An explicit override must be correct: silently falling back to some other
	# workspace would typecheck against the wrong API and report a misleading pass.
	if [ -f "$HUMAIN_TERMINAL_ROOT/$HT_MARKER" ]; then
		ht_root="$HUMAIN_TERMINAL_ROOT"
	else
		say "typecheck: SKIPPED — HUMAIN_TERMINAL_ROOT=$HUMAIN_TERMINAL_ROOT does not contain $HT_MARKER."
		say "typecheck: build HT (its dist/ must exist) or point the variable at the right workspace."
		exit "$SKIP"
	fi
else
	for candidate in \
		"$HOME/Documents/Projects/humain-terminal" \
		"$HOME/Projects/humain-terminal" \
		"$HOME/humain-terminal" \
		"$HOME/src/humain-terminal"
	do
		if [ -f "$candidate/$HT_MARKER" ]; then ht_root="$candidate"; break; fi
	done
fi

if [ -z "$ht_root" ]; then
	say "typecheck: SKIPPED — cannot find an HT workspace containing $HT_MARKER."
	say "typecheck: set HUMAIN_TERMINAL_ROOT=/path/to/humain-terminal and re-run."
	exit "$SKIP"
fi

HT_TYPES="$ht_root/packages/coding-agent/dist/index.d.ts"
HT_MODULES="$ht_root/node_modules"
for required in "$HT_MODULES/typebox" "$HT_MODULES/@types/node"; do
	[ -e "$required" ] || { say "typecheck: SKIPPED — missing $required"; exit "$SKIP"; }
done

# --- locate bun's ambient types (bun:test, Bun globals) ----------------------
# Prefer the cache entry matching the bun actually installed, so the gate checks
# against the same runtime that runs `bun test`; otherwise take the newest.
bun_types=""
if [ -d "$HT_MODULES/bun-types" ]; then
	bun_types="$HT_MODULES/bun-types"
else
	bun_version=$(bun --version 2>/dev/null || true)
	if [ -n "$bun_version" ] && [ -d "$HOME/.bun/install/cache/bun-types@$bun_version@@@1" ]; then
		bun_types="$HOME/.bun/install/cache/bun-types@$bun_version@@@1"
	else
		bun_types=$(find "$HOME/.bun/install/cache" -maxdepth 1 -type d -name 'bun-types@*' 2>/dev/null \
			| sort -t@ -k2 -V | tail -1)
	fi
fi
[ -n "$bun_types" ] && [ -f "$bun_types/index.d.ts" ] \
	|| { say "typecheck: SKIPPED — no bun-types with index.d.ts found (looked in $HT_MODULES and ~/.bun/install/cache)"; exit "$SKIP"; }

# --- locate tsc --------------------------------------------------------------
tsc_cmd=()
if [ -f "$HT_MODULES/typescript/bin/tsc" ] && command -v node >/dev/null 2>&1; then
	tsc_cmd=(node "$HT_MODULES/typescript/bin/tsc")
elif command -v bunx >/dev/null 2>&1; then
	tsc_cmd=(bunx tsc)
else
	say "typecheck: SKIPPED — no tsc available (need node + $HT_MODULES/typescript, or bunx)"
	exit "$SKIP"
fi

# --- generate the tsconfig and run ------------------------------------------
work=$(mktemp -d) || { say "typecheck: SKIPPED — mktemp failed"; exit "$SKIP"; }
trap 'rm -rf "$work"' EXIT
config="$work/tsconfig.json"

# Flags mirror how HT loads the extension: ESM, bundler resolution, .ts
# specifiers allowed, JSON imports (method.json) resolved. Every `paths` entry
# is absolute, so no `baseUrl` is needed — which also keeps this working on
# TypeScript 6, where `baseUrl` was removed outright.
cat >"$config" <<JSON
{
  "compilerOptions": {
    "noEmit": true,
    "strict": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "es2022",
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "ignoreDeprecations": "6.0",
    "types": ["node"],
    "typeRoots": ["$HT_MODULES/@types"],
    "paths": {
      "@humain/terminal": ["$HT_TYPES"],
      "typebox": ["$HT_MODULES/typebox"],
      "typebox/*": ["$HT_MODULES/typebox/*"],
      "bun": ["$bun_types/index.d.ts"],
      "bun:test": ["$bun_types/test.d.ts"]
    }
  },
  "files": ["$bun_types/index.d.ts"],
  "include": ["$TARGET_DIR/*.ts"]
}
JSON

say "typecheck: HT workspace   $ht_root"
say "typecheck: bun types      $bun_types"
say "typecheck: target         $TARGET_DIR/*.ts"

output=$("${tsc_cmd[@]}" -p "$config" 2>&1)
status=$?

if [ "$status" -eq 0 ]; then
	say "typecheck: PASS — 0 diagnostics"
	exit 0
fi

printf '%s\n' "$output"
say "typecheck: FAIL — $(printf '%s\n' "$output" | grep -c 'error TS') diagnostic(s)"
exit 1
