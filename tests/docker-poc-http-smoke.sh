#!/usr/bin/env bash
# Disposable GitHub Actions PoC only: freshly initialized DB, loopback listener.
set -euo pipefail

base="http://127.0.0.1:8080"
secret_file="${RUNNER_TEMP:?}/netarium-bootstrap/bootstrap-secret"
cookies="$RUNNER_TEMP/netarium-poc-auth.cookies"
work="$(mktemp -d)"
trap 'sudo -n rm -f "$secret_file"; rm -rf "$work"' EXIT

csrf_from() {
  local page="$1"
  curl --silent --show-error --fail --cookie "$cookies" --cookie-jar "$cookies" \
    "$base/$page" > "$work/form.html"
  sed -n '/name="csrf_token"/{n;s/.*value="\([^"]*\)".*/\1/p;}' "$work/form.html" | head -n 1
}

csrf="$(csrf_from setup.php)"
test -n "$csrf"
secret="$(sudo -n cat "$secret_file")"
test "${#secret}" -eq 64
password="Xy9!$(openssl rand -hex 16)"

# Bad CSRF must never register a user.
status="$(curl --silent --show-error --output "$work/response" --write-out '%{http_code}' \
  --cookie "$cookies" --cookie-jar "$cookies" \
  --data-urlencode 'csrf_token=invalid' --data-urlencode "bootstrap_secret=$secret" \
  --data-urlencode 'username=poc_ci_admin' --data-urlencode "password=$password" \
  --data-urlencode "password_confirm=$password" "$base/setup.php")"
test "$status" = 200
grep -q '画面の有効期限' "$work/response"

# Valid CSRF with bad secret must be rejected.
status="$(curl --silent --show-error --output "$work/response" --write-out '%{http_code}' \
  --cookie "$cookies" --cookie-jar "$cookies" \
  --data-urlencode "csrf_token=$csrf" --data-urlencode 'bootstrap_secret=invalid' \
  --data-urlencode 'username=poc_ci_admin' --data-urlencode "password=$password" \
  --data-urlencode "password_confirm=$password" "$base/setup.php")"
test "$status" = 403

# Correct one-time secret registers the first administrator.
status="$(curl --silent --show-error --output "$work/response" --write-out '%{http_code}' \
  --cookie "$cookies" --cookie-jar "$cookies" \
  --data-urlencode "csrf_token=$csrf" --data-urlencode "bootstrap_secret=$secret" \
  --data-urlencode 'username=poc_ci_admin' --data-urlencode "password=$password" \
  --data-urlencode "password_confirm=$password" "$base/setup.php")"
test "$status" = 200
grep -q '初期管理者を登録しました' "$work/response"

# Once completed, setup is permanently closed.
status="$(curl --silent --show-error --output "$work/response" --write-out '%{http_code}' \
  --cookie "$cookies" --cookie-jar "$cookies" \
  --data-urlencode "csrf_token=$csrf" --data-urlencode "bootstrap_secret=$secret" \
  --data-urlencode 'username=poc_ci_second' --data-urlencode "password=$password" \
  --data-urlencode "password_confirm=$password" "$base/setup.php")"
test "$status" = 409

docker compose exec -T web php -r '
$db = new SQLite3(getenv("NETARIUM_DB_FILE"), SQLITE3_OPEN_READONLY);
$get = static function (string $key) use ($db): mixed {
    $stmt = $db->prepare("SELECT meta_value FROM app_meta WHERE meta_key = :key");
    $stmt->bindValue(":key", $key, SQLITE3_TEXT);
    return $stmt->execute()->fetchArray(SQLITE3_ASSOC)["meta_value"] ?? null;
};
if ((int)$db->querySingle("SELECT COUNT(*) FROM users") !== 1 ||
    $get("setup_bootstrap_sha256") !== null ||
    $get("setup_completed") !== "1") {
    fwrite(STDERR, "Setup completion state invalid\n"); exit(1);
}
'

# Login with the original browser cookie and call a real lock-protected API.
login_csrf="$(csrf_from login.php)"
test -n "$login_csrf"
status="$(curl --silent --show-error --output "$work/response" --write-out '%{http_code}' \
  --cookie "$cookies" --cookie-jar "$cookies" \
  --data-urlencode "csrf_token=$login_csrf" \
  --data-urlencode 'username=poc_ci_admin' --data-urlencode "password=$password" \
  "$base/login.php")"
test "$status" = 302

status="$(curl --silent --show-error --output "$work/response" --write-out '%{http_code}' \
  --cookie "$cookies" "$base/api.php?action=load")"
test "$status" = 200
grep -q '"ok":true' "$work/response"
grep -q '"username":"poc_ci_admin"' "$work/response"

# Render the authenticated main page, including its PHP templates.
curl --fail --silent --show-error --cookie "$cookies" "$base/index.php" -o "$work/index.html"
grep -q 'window.APP_CONFIG' "$work/index.html"

# Do not print credentials or secret in CI logs.
echo 'HTTP setup, CSRF rejection, wrong secret, re-registration, login, authenticated load and main page rendering: PASS'
