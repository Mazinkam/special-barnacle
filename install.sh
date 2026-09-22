#!/usr/bin/env bash
# Install the HUMAIN Terminal bridge files for the hierarchical agent orchestrator.
#
# This script symlinks the bridge (extensions + agent definitions) into
# ~/.humain-terminal/agent/ so the HT runtime can load them. The canonical
# source lives in this repo under bridge/; the symlinks make the runtime
# see thosesame bytes.
#
# Idempotent: re-running is safe and prints the action taken for each entry.
# Refuses to overwrite a real file/dir that is not a symlink — move it away
# first if you want the symlink to land.
#
# Usage:
#   ./install.sh           # install (idempotent)
#   ./install.sh --uninstall   # remove the symlinks we manage
set -euo pipefail

SKILL_ROOT="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$SKILL_ROOT/bridge"
TARGET_DIR="${HUMAIN_TERMINAL_AGENT_DIR:-$HOME/.humain-terminal/agent}"

EXTENSIONS_SRC="$BRIDGE_DIR/extensions"
EXTENSIONS_DST="$TARGET_DIR/extensions"
AGENTS_SRC="$BRIDGE_DIR/agents"
AGENTS_DST="$TARGET_DIR/agents"

STATE_ROOT="${HUMAIN_ORCHESTRATOR_STATE_ROOT:-$HOME/.local/state/coding-agent-orchestrator}"
PYTHON_BIN="${HUMAIN_ORCHESTRATOR_PYTHON:-$(command -v python3 || echo python3)}"
LAUNCHD_LABEL="com.humain.orchestrator-ingest"
LAUNCHD_DST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
LAUNCHD_INTERVAL="${HUMAIN_ORCHESTRATOR_INGEST_INTERVAL:-900}"   # seconds

UNINSTALL=0
[ "${1:-}" = "--uninstall" ] && UNINSTALL=1

log() { printf '[install] %s\n' "$*"; }
warn() { printf '[install] WARN: %s\n' "$*" >&2; }
fail() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

# Mapping: "source_file|dest_dir" — keeps the two sides in sync and easy to audit.
map_entries() {
    local src_dir="$1" dst_dir="$2"
    [ -d "$src_dir" ] || return 0
    for entry in "$src_dir"/*; do
        [ -e "$entry" ] || continue
        printf '%s|%s\n' "$entry" "$dst_dir/$(basename "$entry")"
    done
}

install_one() {
    local src="$1" dst="$2"
    local name
    name="$(basename "$dst")"

    if [ -L "$dst" ]; then
        # Existing symlink. Pointing at the right place already?
        local current
        current="$(readlink "$dst")"
        if [ "$current" = "$src" ]; then
            log "ok        $name (symlink already in place)"
            return 0
        fi
        log "replace   $name (symlink -> $current -> $(basename "$src"))"
        rm "$dst"
        ln -s "$src" "$dst"
        return 0
    fi
    if [ -e "$dst" ]; then
        warn "refusing to overwrite non-symlink $dst; move it away and re-run"
        return 0
    fi
    mkdir -p "$(dirname "$dst")"
    ln -s "$src" "$dst"
    log "install   $name"
}

uninstall_one() {
    local src="$1" dst="$2"
    local name
    name="$(basename "$dst")"

    if [ -L "$dst" ]; then
        local current
        current="$(readlink "$dst")"
        if [ "$current" = "$src" ]; then
            rm "$dst"
            log "uninstall $name"
        else
            log "skip      $name (symlink points elsewhere: $current)"
        fi
        return 0
    fi
    if [ -e "$dst" ]; then
        log "skip      $name (real file/dir — leaving alone)"
    fi
}

# ---------------------------------------------------------------------------
# launchd sweep: the safety net behind the extension's per-turn ingest hook.
# Catches sessions the hook cannot see (HT crashed, extension not loaded,
# Codex CLI) by re-scanning recent session logs. Session-granularity rows are
# deltas, so hook + sweep never double count.
# ---------------------------------------------------------------------------
render_launchd_plist() {
    cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$PYTHON_BIN</string>
    <string>-m</string><string>orchestrator.cli</string>
    <string>ingest</string><string>--discover</string>
    <string>--since-days</string><string>2</string>
    <string>--granularity</string><string>session</string>
    <string>--quiet</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PYTHONPATH</key><string>$SKILL_ROOT</string>
    <key>CODING_AGENT_ORCHESTRATOR_HOME</key><string>$STATE_ROOT</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>WorkingDirectory</key><string>$SKILL_ROOT</string>
  <key>StartInterval</key><integer>$LAUNCHD_INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>LowPriorityIO</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$STATE_ROOT/ingest-launchd.log</string>
  <key>StandardErrorPath</key><string>$STATE_ROOT/ingest-launchd.log</string>
</dict></plist>
PLIST
}

install_launchd() {
    if [ "$(uname -s)" != "Darwin" ]; then
        log "skip      launchd sweep (not macOS; schedule this yourself:"
        log "          PYTHONPATH=$SKILL_ROOT $PYTHON_BIN -m orchestrator.cli ingest --discover --since-days 2 --granularity session --quiet)"
        return 0
    fi
    mkdir -p "$(dirname "$LAUNCHD_DST")" "$STATE_ROOT"
    local tmp
    tmp="$(mktemp)"
    render_launchd_plist > "$tmp"
    if [ -f "$LAUNCHD_DST" ] && cmp -s "$tmp" "$LAUNCHD_DST"; then
        rm -f "$tmp"
        log "ok        $LAUNCHD_LABEL (launchd sweep every ${LAUNCHD_INTERVAL}s already installed)"
    else
        mv "$tmp" "$LAUNCHD_DST"
        log "install   $LAUNCHD_LABEL (launchd sweep every ${LAUNCHD_INTERVAL}s)"
    fi
    # (Re)load so edits take effect. bootout is allowed to fail when not loaded.
    launchctl bootout "gui/$(id -u)" "$LAUNCHD_DST" >/dev/null 2>&1 || true
    if launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_DST" >/dev/null 2>&1; then
        log "loaded    $LAUNCHD_LABEL (log: $STATE_ROOT/ingest-launchd.log)"
    else
        warn "launchctl bootstrap failed; load manually: launchctl bootstrap gui/$(id -u) $LAUNCHD_DST"
    fi
}

uninstall_launchd() {
    [ "$(uname -s)" = "Darwin" ] || return 0
    if [ -f "$LAUNCHD_DST" ]; then
        launchctl bootout "gui/$(id -u)" "$LAUNCHD_DST" >/dev/null 2>&1 || true
        rm -f "$LAUNCHD_DST"
        log "uninstall $LAUNCHD_LABEL"
    fi
}

main() {
    if [ ! -d "$BRIDGE_DIR" ]; then
        fail "bridge/ not found at $BRIDGE_DIR — re-clone the repo?"
    fi

    log "skill:    $SKILL_ROOT"
    log "bridge:   $BRIDGE_DIR"
    log "runtime:  $TARGET_DIR"
    log ""

    if [ "$UNINSTALL" -eq 1 ]; then
        log "mode: uninstall"
        while IFS='|' read -r src dst; do
            [ -n "${src:-}" ] || continue
            uninstall_one "$src" "$dst"
        done < <(map_entries "$EXTENSIONS_SRC" "$EXTENSIONS_DST"; map_entries "$AGENTS_SRC" "$AGENTS_DST")
        uninstall_launchd
        log ""
        log "uninstall done. reload HT to drop the registered commands."
        return 0
    fi

    log "mode: install"
    # The extension moved from a single file to a directory (orchestrator/index.ts).
    # A stale file symlink would load a second, dead copy; drop it.
    if [ -L "$EXTENSIONS_DST/orchestrator.ts" ]; then
        rm "$EXTENSIONS_DST/orchestrator.ts"
        log "remove    orchestrator.ts (superseded by orchestrator/ directory)"
    fi
    while IFS='|' read -r src dst; do
        [ -n "${src:-}" ] || continue
        install_one "$src" "$dst"
    done < <(map_entries "$EXTENSIONS_SRC" "$EXTENSIONS_DST"; map_entries "$AGENTS_SRC" "$AGENTS_DST")
    install_launchd
    log ""
    log "install done. run /reload in HT (or restart) to pick up the new commands:"
    log "  /reload"
    log "  /orchestrate <goal> [--task-class T] [--complexity N] [--risk R]"
    log "  /orchestrator-models [list|set|use|pick|validate --live]"
    log "  /orchestrator-roi"
}

main "$@"
