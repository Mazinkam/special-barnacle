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
    log ""
    log "install done. run /reload in HT (or restart) to pick up the new commands:"
    log "  /reload"
    log "  /orchestrate <goal> [--task-class T] [--complexity N] [--risk R]"
    log "  /orchestrator-models [list|set|use|pick|validate --live]"
    log "  /orchestrator-roi"
}

main "$@"
