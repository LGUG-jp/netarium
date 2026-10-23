#!/usr/bin/env bash
# Host administrator CLI for Docker-based update and rollback.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="compose.yaml"
DO_BACKUP=1

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
        --no-backup)
            DO_BACKUP=0
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [-f compose.yaml|compose.image.yaml] [--no-backup]"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            echo "Usage: $0 [-f compose.yaml|compose.image.yaml] [--no-backup]" >&2
            exit 1
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

echo "=== Netarium Docker Update ==="
echo "Compose file: $COMPOSE_FILE"

# Record current image identity before building/pulling so pre-update backup and rollback use the exact prior image.
TARGET_IMAGE_REF="$("${COMPOSE_CMD[@]}" config --images web 2>/dev/null | head -n 1 || true)"
ORIG_TARGET_IMAGE_ID=""
if [ -n "$TARGET_IMAGE_REF" ]; then
    ORIG_TARGET_IMAGE_ID="$(docker image inspect --format='{{.Id}}' "$TARGET_IMAGE_REF" 2>/dev/null || true)"
fi
PREV_IMAGE_ID=""
WEB_CID="$("${COMPOSE_CMD[@]}" ps -aq web 2>/dev/null | head -n 1 || true)"
if [ -n "$WEB_CID" ]; then
    PREV_IMAGE_ID="$(docker inspect --format='{{.Image}}' "$WEB_CID" 2>/dev/null || true)"
fi
if [ -z "$PREV_IMAGE_ID" ] && [ -n "$ORIG_TARGET_IMAGE_ID" ]; then
    PREV_IMAGE_ID="$ORIG_TARGET_IMAGE_ID"
fi
PREV_IMAGE_REF="$PREV_IMAGE_ID"

restore_previous_image() {
    if [ -n "$PREV_IMAGE_ID" ] && [ -n "$TARGET_IMAGE_REF" ]; then
        echo "Restoring previous image tag ($TARGET_IMAGE_REF -> $PREV_IMAGE_REF)..." >&2
        if ! docker image tag "$PREV_IMAGE_REF" "$TARGET_IMAGE_REF"; then
            echo "FATAL: Cannot restore previous image reference ($PREV_IMAGE_REF). Web must remain stopped." >&2
            exit 2
        fi
    fi
}

# Pin TARGET_IMAGE_REF to the running container's image during Step 1 so the pre-update backup
# is produced by the currently deployed application version rather than an unapplied target tag.
if [ -n "$PREV_IMAGE_ID" ] && [ -n "$TARGET_IMAGE_REF" ]; then
    if ! docker image tag "$PREV_IMAGE_ID" "$TARGET_IMAGE_REF"; then
        echo "Error: Cannot pin the running image to the target reference; update aborted before stopping Web. Use a mutable version tag, not a digest reference." >&2
        exit 1
    fi
    # Keep a named reference: containerd can discard an untagged image lookup
    # after build/pull replaces TARGET_IMAGE_REF, even while its container exists.
    PREV_IMAGE_REF="netarium-rollback:$(openssl rand -hex 12)"
    if ! docker image tag "$PREV_IMAGE_ID" "$PREV_IMAGE_REF"; then
        echo "Error: Cannot retain the running image; update aborted before stopping Web." >&2
        exit 1
    fi
fi

BACKUP_FILE=""
if [ "$DO_BACKUP" -eq 1 ]; then
    BACKUP_DIR="$REPO_ROOT/backups"
    mkdir -p "$BACKUP_DIR"
    chmod 0700 "$BACKUP_DIR" 2>/dev/null || true
    FILENAME="pre-update-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 6).zip"
    BACKUP_FILE="$BACKUP_DIR/$FILENAME"
    echo "Step 1: Stopping Web container and creating pre-update backup at $BACKUP_FILE..."
    if ! bash scripts/docker-backup.sh -f "$COMPOSE_FILE" --keep-stopped "$BACKUP_FILE"; then
        echo "Error: Pre-update backup failed. Resuming Web container without updating..." >&2
        restore_previous_image
        "${COMPOSE_CMD[@]}" up -d web || true
        exit 1
    fi
else
    echo "Step 1: Stopping Web container for update (--no-backup specified)..."
    "${COMPOSE_CMD[@]}" stop web
fi

rollback() {
    echo "CRITICAL: Update failed. Initiating rollback..." >&2
    "${COMPOSE_CMD[@]}" stop web || true
    "${COMPOSE_CMD[@]}" rm -f web >/dev/null 2>&1 || true
    restore_previous_image
    if [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ]; then
        echo "Restoring database and storage from pre-update backup: $BACKUP_FILE" >&2
        bash scripts/docker-restore.sh -f "$COMPOSE_FILE" "$BACKUP_FILE" || {
            echo "FATAL: Rollback restore failed. Web container kept stopped for inspection." >&2
            exit 2
        }
        echo "Rollback completed. Web container resumed with prior image and data." >&2
    else
        echo "No backup file available; resuming Web container with prior image..." >&2
        "${COMPOSE_CMD[@]}" up -d web || true
    fi
}

echo "Step 2: Building or pulling updated image..."
if grep -q "image:" "$COMPOSE_FILE" && ! grep -q "build:" "$COMPOSE_FILE"; then
    if [ -n "$ORIG_TARGET_IMAGE_ID" ] && [ -n "$TARGET_IMAGE_REF" ]; then
        if ! docker image tag "$ORIG_TARGET_IMAGE_ID" "$TARGET_IMAGE_REF"; then
            echo "FATAL: Cannot select the target image reference. Web kept stopped." >&2
            exit 2
        fi
    elif [ -z "$ORIG_TARGET_IMAGE_ID" ] && [ -n "$TARGET_IMAGE_REF" ] && [ -n "$PREV_IMAGE_ID" ]; then
        docker rmi "$TARGET_IMAGE_REF" >/dev/null 2>&1 || true
    fi
    if ! "${COMPOSE_CMD[@]}" pull web; then
        echo "Error: Failed to pull updated image. Resuming prior Web container..." >&2
        restore_previous_image
        "${COMPOSE_CMD[@]}" up -d web || true
        exit 1
    fi
else
    if ! "${COMPOSE_CMD[@]}" build web; then
        echo "Error: Failed to build updated image. Resuming prior Web container..." >&2
        restore_previous_image
        "${COMPOSE_CMD[@]}" up -d web || true
        exit 1
    fi
fi
echo "Step 3: Running database migration and installation check..."
if ! "${COMPOSE_CMD[@]}" run --rm --no-deps web php -r '
    require "/var/www/html/src/Core/Config.php";
    $cfg = \Netarium\Core\Config::create("/var/www/html");
    $cmd = escapeshellcmd(PHP_BINARY)
        . " " . escapeshellarg("/var/www/html/scripts/check-install.php")
        . " --app-root=/var/www/html"
        . " --storage-dir=" . escapeshellarg((string)$cfg["storage_dir"])
        . " --db-file=" . escapeshellarg((string)$cfg["db_file"])
        . " --allow-orphan-images";
    passthru($cmd, $code);
    exit($code);
'; then
    echo "Error: Database migration or pre-start check failed." >&2
    rollback
    exit 1
fi

echo "Step 4: Starting updated Web container..."
if ! "${COMPOSE_CMD[@]}" up -d web; then
    echo "Error: Failed to start updated Web container." >&2
    rollback
    exit 1
fi

echo "Step 5: Verifying healthcheck..."
healthy=0
for i in $(seq 1 15); do
    sleep 2
    health_out="$("${COMPOSE_CMD[@]}" exec -T web curl -fsS http://127.0.0.1:8080/healthcheck.php 2>/dev/null || true)"
    if echo "$health_out" | grep -q '"status":"ok"'; then
        healthy=1
        break
    fi
    echo "Waiting for healthcheck to pass... ($i/15)"
done

if [ "$healthy" -ne 1 ]; then
    echo "Error: Healthcheck failed after update." >&2
    rollback
    exit 1
fi

echo "=== Netarium Docker update completed successfully ==="
if [[ "$PREV_IMAGE_REF" == netarium-rollback:* ]]; then
    docker image rm "$PREV_IMAGE_REF" >/dev/null
fi
