#!/usr/bin/env bash
# Host administrator CLI for Docker-based full restore.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="compose.yaml"
ARCHIVE_ARG=""

while [ $# -gt 0 ]; do
    case "$1" in
        -f|--file)
            if [ $# -lt 2 ]; then
                echo "Error: Missing argument for $1" >&2
                exit 1
            fi
            COMPOSE_FILE="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [-f compose.yaml|compose.image.yaml] <path-to-netarium-full-archive.zip>"
            exit 0
            ;;
        -*)
            echo "Unknown option: $1" >&2
            echo "Usage: $0 [-f compose.yaml|compose.image.yaml] <path-to-netarium-full-archive.zip>" >&2
            exit 1
            ;;
        *)
            if [ -n "$ARCHIVE_ARG" ]; then
                echo "Error: Unexpected argument: $1" >&2
                exit 1
            fi
            ARCHIVE_ARG="$1"
            shift
            ;;
    esac
done

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "Error: Compose file not found: $COMPOSE_FILE" >&2
    exit 1
fi

if [ -z "$ARCHIVE_ARG" ]; then
    echo "Usage: $0 [-f compose.yaml|compose.image.yaml] <path-to-netarium-full-archive.zip>" >&2
    exit 1
fi

if [ ! -f "$ARCHIVE_ARG" ]; then
    echo "Error: Archive file not found: $ARCHIVE_ARG" >&2
    exit 1
fi

COMPOSE_CMD=(docker compose -f "$COMPOSE_FILE")

LOCK_FILE="$REPO_ROOT/.docker-admin.lock"
acquire_admin_lock() {
    if [ "${NETARIUM_ADMIN_LOCK_HELD:-0}" = "1" ]; then
        return 0
    fi
    if [ ! -e "$LOCK_FILE" ]; then
        : > "$LOCK_FILE" 2>/dev/null || true
        repo_owner="$(stat -c '%u:%g' "$REPO_ROOT" 2>/dev/null || true)"
        if [ -n "$repo_owner" ]; then
            chown "$repo_owner" "$LOCK_FILE" 2>/dev/null || true
        fi
        chmod 0644 "$LOCK_FILE" 2>/dev/null || true
    fi
    exec 9<"$LOCK_FILE"
    if ! flock -n 9; then
        echo "Error: Another Docker administrative operation is already in progress." >&2
        exit 1
    fi
    export NETARIUM_ADMIN_LOCK_HELD=1
}

acquire_admin_lock
ARCHIVE_PATH="$(cd "$(dirname "$ARCHIVE_ARG")" && pwd)/$(basename "$ARCHIVE_ARG")"
ARCHIVE_DIR="$(dirname "$ARCHIVE_PATH")"
ARCHIVE_FILENAME="$(basename "$ARCHIVE_PATH")"

echo "=== Netarium Docker Full Restore ==="
echo "Compose file: $COMPOSE_FILE"
echo "Archive: $ARCHIVE_PATH"

web_stopped=0
safe_to_resume=0

cleanup_web() {
    if [ "$web_stopped" -eq 1 ]; then
        if [ "$safe_to_resume" -eq 1 ]; then
            echo "Resuming Web container..."
            "${COMPOSE_CMD[@]}" up -d web || true
        else
            echo "CRITICAL: Web container remains STOPPED for administrator inspection."
            echo "Do not start Web until storage integrity is manually verified."
        fi
    fi
}
trap cleanup_web EXIT

echo "Step 1: Pre-flight verification while Web is still running..."
"${COMPOSE_CMD[@]}" run --rm --no-deps --user 0:0 \
    -v "$ARCHIVE_DIR:/backup-in:ro" \
    web php scripts/docker-restore-runner.php --verify-only --archive="/backup-in/$ARCHIVE_FILENAME"
echo "Pre-flight verification passed."

echo "Step 2: Stopping Web container for atomic placement..."
"${COMPOSE_CMD[@]}" stop web
web_stopped=1
safe_to_resume=0

echo "Step 3: Performing atomic replacement and post-restore checks..."
set +e
"${COMPOSE_CMD[@]}" run --rm --no-deps --user 0:0 \
    -v "$ARCHIVE_DIR:/backup-in:ro" \
    web php scripts/docker-restore-runner.php --apply --archive="/backup-in/$ARCHIVE_FILENAME"
restore_status=$?
set -e

if [ "$restore_status" -eq 0 ]; then
    echo "Step 4: Restore succeeded. Resuming Web container..."
    "${COMPOSE_CMD[@]}" up -d web
    web_stopped=0
    safe_to_resume=1
    echo "=== Full restore completed successfully ==="
elif [ "$restore_status" -eq 1 ]; then
    echo "Error: Restore failed, but rollback succeeded. Prior database was restored." >&2
    safe_to_resume=1
    exit 1
else
    echo "FATAL: Restore and rollback encountered critical errors." >&2
    echo "Web container must NOT be started." >&2
    safe_to_resume=0
    exit 2
fi
