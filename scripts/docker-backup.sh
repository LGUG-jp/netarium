#!/usr/bin/env bash
# Host administrator CLI for Docker-based full backup.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="compose.yaml"
KEEP_STOPPED=0
DEST_ARG=""

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
        --keep-stopped)
            KEEP_STOPPED=1
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [-f compose.yaml|compose.image.yaml] [--keep-stopped] [output-zip-path]"
            exit 0
            ;;
        -*)
            echo "Unknown option: $1" >&2
            echo "Usage: $0 [-f compose.yaml|compose.image.yaml] [--keep-stopped] [output-zip-path]" >&2
            exit 1
            ;;
        *)
            if [ -n "$DEST_ARG" ]; then
                echo "Error: Unexpected argument: $1" >&2
                exit 1
            fi
            DEST_ARG="$1"
            shift
            ;;
    esac
done

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "Error: Compose file not found: $COMPOSE_FILE" >&2
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
created_backup_dir=0
if [ -z "$DEST_ARG" ]; then
    BACKUP_DIR="$REPO_ROOT/backups"
    if [ ! -d "$BACKUP_DIR" ]; then
        mkdir -p "$BACKUP_DIR"
        created_backup_dir=1
    fi
    chmod 0700 "$BACKUP_DIR" 2>/dev/null || true
    FILENAME="netarium-full-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 8).zip"
    DEST_PATH="$BACKUP_DIR/$FILENAME"
elif [ -d "$DEST_ARG" ]; then
    BACKUP_DIR="$(cd "$DEST_ARG" && pwd)"
    FILENAME="netarium-full-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 8).zip"
    DEST_PATH="$BACKUP_DIR/$FILENAME"
else
    parent_dir="$(dirname "$DEST_ARG")"
    if [ ! -d "$parent_dir" ]; then
        mkdir -p "$parent_dir"
        created_backup_dir=1
    fi
    BACKUP_DIR="$(cd "$parent_dir" && pwd)"
    if [ "$created_backup_dir" -eq 1 ] || [ "$BACKUP_DIR" = "$REPO_ROOT/backups" ]; then
        chmod 0700 "$BACKUP_DIR" 2>/dev/null || true
    fi
    FILENAME="$(basename "$DEST_ARG")"
    DEST_PATH="$BACKUP_DIR/$FILENAME"
fi

if [ ! -w "$BACKUP_DIR" ]; then
    echo "Error: Backup directory is not writable: $BACKUP_DIR" >&2
    exit 1
fi

echo "=== Netarium Docker Full Backup ==="
echo "Compose file: $COMPOSE_FILE"
echo "Target: $DEST_PATH"

web_stopped=0
cleanup_web() {
    if [ "$web_stopped" -eq 1 ] && [ "$KEEP_STOPPED" -eq 0 ]; then
        echo "Ensuring Web container is resumed..."
        "${COMPOSE_CMD[@]}" up -d web || true
    fi
}
trap cleanup_web EXIT

echo "Stopping Web container for consistent snapshot..."
"${COMPOSE_CMD[@]}" stop web
web_stopped=1

HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

echo "Executing full backup worker inside one-shot management container..."
"${COMPOSE_CMD[@]}" run --rm --no-deps --user 0:0 \
    -v "$BACKUP_DIR:/backup-out" \
    web php scripts/docker-backup-runner.php \
    --output="/backup-out/$FILENAME" \
    --owner-uid="$HOST_UID" \
    --owner-gid="$HOST_GID"

if [ "$KEEP_STOPPED" -eq 0 ]; then
    echo "Resuming Web container..."
    "${COMPOSE_CMD[@]}" up -d web
    web_stopped=0
else
    echo "Web container kept stopped (--keep-stopped)."
fi

echo "=== Full backup completed successfully ==="
echo "Archive: $DEST_PATH"
if command -v sha256sum >/dev/null 2>&1; then
    checksum="$(sha256sum "$DEST_PATH" | awk '{print $1}')"
    echo "SHA256:  $checksum"
fi
ls -lh "$DEST_PATH"
