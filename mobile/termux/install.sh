#!/data/data/com.termux/files/usr/bin/bash
# Installs the Automa server that ships inside the Automa app into Termux:
# Node.js and PostgreSQL from Termux packages, a local "automa" database, the
# server packages from this folder, and an `automa` command that starts both.
#
# The Automa app hands this folder to Termux ("Send setup to Termux"); see
# mobile/README.md. Safe to run again: every step skips work already done, and
# running it with a newer app's bundle updates the server in place.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
automa_home="${AUTOMA_HOME:-$HOME/.automa}"
server_dir="$automa_home/server"
pgdata="${AUTOMA_PGDATA:-$PREFIX/var/lib/postgresql}"
version="$(cat "$here/VERSION")"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

if [ -z "${PREFIX:-}" ] || [ ! -d "$PREFIX/bin" ]; then
  echo "Run this inside the Termux app." >&2
  exit 1
fi

# Keep Android from pausing Termux in the background while this runs.
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
  trap 'command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock || true' EXIT
fi

say "Checking Node.js and PostgreSQL"
if ! command -v node >/dev/null 2>&1 || ! command -v pg_ctl >/dev/null 2>&1; then
  # git: tasks that use a project repository check it out before the agent runs.
  pkg install -y nodejs-lts postgresql git
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 24 ]; then
  echo "Automa needs Node.js 24 or newer (found $(node --version)). Run: pkg upgrade -y" >&2
  exit 1
fi

say "Setting up the database"
# On a phone every app can reach 127.0.0.1, so the database asks for a
# password even from loopback (scram-sha-256). The password is made once and
# kept readable by Termux alone; the automa command puts it in DATABASE_URL.
db_password_file="$automa_home/db-password"
mkdir -p "$automa_home"
if [ ! -s "$db_password_file" ]; then
  (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$db_password_file")
fi
db_user="$(id -un)"
if [ ! -f "$pgdata/PG_VERSION" ]; then
  mkdir -p "$pgdata"
  initdb --auth=scram-sha-256 --pwfile="$db_password_file" "$pgdata" >/dev/null
fi
if ! pg_ctl -D "$pgdata" status >/dev/null 2>&1; then
  pg_ctl -D "$pgdata" -l "$pgdata/server.log" -w start >/dev/null
fi
export PGPASSWORD="$(cat "$db_password_file")"
# A database made by an earlier installer trusted every local connection:
# give it the password and require it from now on. The replication lines
# count too: left on trust, any app on the phone could copy the database.
if grep -Eq '^(local|host)\s+(all|replication)\s+all\s+.*\btrust\s*$' "$pgdata/pg_hba.conf" 2>/dev/null; then
  say "Locking the database to a password"
  psql -h 127.0.0.1 -d postgres -tAc "alter user \"$db_user\" with password '$PGPASSWORD'" >/dev/null
  sed -i -E 's/^((local|host)\s+(all|replication)\s+all\s+\S*\s*)trust\s*$/\1scram-sha-256/' "$pgdata/pg_hba.conf"
  pg_ctl -D "$pgdata" reload >/dev/null
fi
if ! psql -h 127.0.0.1 -d postgres -tAc "select 1 from pg_database where datname = 'automa'" | grep -q 1; then
  createdb -h 127.0.0.1 automa
fi

installed_version="$(cat "$server_dir/.automa-version" 2>/dev/null || true)"
if [ "$installed_version" = "$version" ] && [ -f "$server_dir/node_modules/paperclipai/dist/index.js" ]; then
  say "Automa server $version is already installed"
else
  if [ -n "$installed_version" ]; then
    say "Updating the Automa server $installed_version -> $version (reuses what is already downloaded)"
  else
    say "Installing the Automa server $version"
    say "The first install downloads about 380 packages: 10 to 45 minutes depending on your connection."
    say "npm stays quiet until it finishes. Keep Termux open and the phone on charge."
  fi
  # The app ships the packages unpacked (xz-compressed); npm installs tarballs.
  tarballs="$here/tarballs"
  rm -rf "$tarballs"
  mkdir -p "$tarballs" "$server_dir"
  for pkg in "$here"/packages/*/; do
    tar -czf "$tarballs/$(basename "$pkg").tgz" -C "$pkg" package
  done
  npm install --prefix "$server_dir" --omit=dev --prefer-offline --no-audit --no-fund --loglevel=error "$tarballs"/*.tgz

  if [ "$(node -p process.platform)" = "android" ]; then
    say "Adding the portable image library (sharp for Android)"
    node "$here/add-sharp-wasm.mjs" "$server_dir"
  fi
  printf '%s\n' "$version" > "$server_dir/.automa-version"
fi

say "Adding the automa command"
mkdir -p "$automa_home/bin"
cp "$here/automa-adb-link.sh" "$automa_home/bin/automa-adb-link"
chmod 700 "$automa_home/bin/automa-adb-link"
# The app key: on a phone every app can reach 127.0.0.1, so Automa only answers
# the Automa app, which gets this key (PAPERCLIP_LOCAL_TRUSTED_SECRET) from the
# launcher. Made once, kept readable by Termux alone.
secret_file="$automa_home/app-secret"
if [ ! -s "$secret_file" ]; then
  (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$secret_file")
fi
cat > "$PREFIX/bin/automa" <<LAUNCHER
#!$PREFIX/bin/bash
# Starts the Automa database when it is not running, then the Automa server CLI.
# Usage: automa run        runs Automa here, and starts it again if it stops
#        automa start      the same, in the background (the Automa app and Termux:Boot use this)
#        automa stop       stops Automa started with automa start
#        automa status     says whether Automa is running
#        automa link       hands the app key to the Automa app again (prints it too)
#        automa adb link   links this phone's own Wireless debugging, so agents can run adb shell
#        (or any paperclipai command: automa doctor, automa onboard)
set -e
export PAPERCLIP_LOCAL_TRUSTED_SECRET="\$(cat "$secret_file")"
# Opens the Automa app on this phone's Automa with the app key. The first time
# the app asks for one tap on Connect; after that it checks the key against
# this server and connects by itself, counting down while the server starts.
link_app() {
  command -v am >/dev/null 2>&1 || return 1
  am start -n com.corxlabs.automa/.MainActivity \\
    --es com.corxlabs.automa.CONNECT http://127.0.0.1:3100 \\
    --es com.corxlabs.automa.SECRET "\$PAPERCLIP_LOCAL_TRUSTED_SECRET" >/dev/null 2>&1
}
case "\${1:-}" in
  adb)
    shift
    command -v adb >/dev/null 2>&1 || pkg install -y android-tools
    case "\${1:-}" in
      link|"") exec "$automa_home/bin/automa-adb-link" ;;
      pair) exec adb pair "127.0.0.1:\${2:?usage: automa adb pair PAIRING-PORT CODE}" "\${3:?usage: automa adb pair PAIRING-PORT CODE}" ;;
      connect) exec adb connect "127.0.0.1:\${2:?usage: automa adb connect PORT}" ;;
      *) exec adb "\$@" ;;
    esac
    ;;
  start)
    # Already up: nothing to do. Otherwise the supervisor below runs in the
    # background, its output in ~/.automa/server.log.
    if [ -s "$automa_home/automa.pid" ] && kill -0 "\$(cat "$automa_home/automa.pid")" 2>/dev/null; then
      echo "Automa is already running."
      exit 0
    fi
    AUTOMA_NO_APP=1 nohup "\$0" run >"$automa_home/server.log" 2>&1 </dev/null &
    echo "Automa is starting (log: $automa_home/server.log)."
    exit 0
    ;;
  stop)
    if [ -s "$automa_home/automa.pid" ] && kill -0 "\$(cat "$automa_home/automa.pid")" 2>/dev/null; then
      kill -TERM "\$(cat "$automa_home/automa.pid")"
      rm -f "$automa_home/automa.pid"
      command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock || true
      echo "Automa stopped."
    else
      echo "Automa is not running in the background."
    fi
    exit 0
    ;;
  status)
    if node -e "fetch('http://127.0.0.1:3100/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then
      echo "Automa is running on http://127.0.0.1:3100"
    else
      echo "Automa is not answering. Start it with: automa run"
      exit 1
    fi
    exit 0
    ;;
  link)
    echo "App key for the Automa app (Run Automa on this phone -> paste the app key):"
    echo "\$PAPERCLIP_LOCAL_TRUSTED_SECRET"
    if link_app; then echo "Opened the Automa app (the first time, tap Connect there)."; else echo "Could not open the Automa app from here; paste the key in the app instead."; fi
    exit 0
    ;;
esac
if ! pg_ctl -D "$pgdata" status >/dev/null 2>&1; then
  pg_ctl -D "$pgdata" -l "$pgdata/server.log" -w start >/dev/null
fi
export DATABASE_URL="\${DATABASE_URL:-postgres://\$(id -un):\$(cat "$db_password_file")@127.0.0.1:5432/automa}"
# A running server holds a wake lock so Android does not pause it, and the app
# is told where Automa is (it waits for the server to come up).
if [ "\${1:-}" = "run" ] || [ "\${1:-}" = "onboard" ]; then
  command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true
  [ -n "\${AUTOMA_NO_APP:-}" ] || link_app || true
fi
if [ "\${1:-}" = "run" ]; then
  # One Automa at a time: a second one (the app or Termux:Boot starting it
  # while it already runs) would only fight the first for the port.
  if [ -s "$automa_home/automa.pid" ] && [ "\$(cat "$automa_home/automa.pid")" != "\$\$" ] && kill -0 "\$(cat "$automa_home/automa.pid")" 2>/dev/null; then
    echo "Automa is already running. Stop it with: automa stop"
    exit 0
  fi
  echo "\$\$" > "$automa_home/automa.pid"
  # Keeps Automa up: when Android or a crash stops the server, it starts again.
  # Ctrl+C (or automa stop) ends it for good.
  child=""
  finish() {
    [ -n "\$child" ] && kill -TERM "\$child" 2>/dev/null && wait "\$child" 2>/dev/null
    [ "\$(cat "$automa_home/automa.pid" 2>/dev/null)" = "\$\$" ] && rm -f "$automa_home/automa.pid"
    exit 0
  }
  trap finish INT TERM HUP
  while true; do
    node "$server_dir/node_modules/paperclipai/dist/index.js" "\$@" &
    child=\$!
    code=0
    wait "\$child" || code=\$?
    child=""
    [ "\$code" -eq 0 ] && finish
    echo "Automa stopped (exit \$code). Starting it again in 3 seconds..." >&2
    sleep 3
    pg_ctl -D "$pgdata" status >/dev/null 2>&1 || pg_ctl -D "$pgdata" -l "$pgdata/server.log" -w start >/dev/null || true
  done
fi
exec node "$server_dir/node_modules/paperclipai/dist/index.js" "\$@"
LAUNCHER
chmod 700 "$PREFIX/bin/automa"

say "Letting the Automa app start Automa, and starting it when the phone boots"
# The app starts Automa through Termux's RUN_COMMAND, which Termux only allows
# once allow-external-apps is on. Android still asks you once in the app.
mkdir -p "$HOME/.termux"
if ! grep -qs '^allow-external-apps *= *true' "$HOME/.termux/termux.properties"; then
  printf '\nallow-external-apps = true\n' >> "$HOME/.termux/termux.properties"
  command -v termux-reload-settings >/dev/null 2>&1 && termux-reload-settings || true
fi
# With the Termux:Boot app installed (F-Droid), Automa starts when the phone does.
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/automa" <<BOOT
#!$PREFIX/bin/sh
termux-wake-lock
exec "$PREFIX/bin/automa" start
BOOT
chmod 700 "$HOME/.termux/boot/automa"

say "Installed. Starting Automa on http://127.0.0.1:3100 (locked to the Automa app)"
say "The Automa app opens by itself: tap Connect there. Next time, open Termux and run: automa run"
if [ "${AUTOMA_INSTALL_NO_START:-0}" = "1" ]; then
  exit 0
fi
exec automa onboard --yes
