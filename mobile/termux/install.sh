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
  pkg install -y nodejs-lts postgresql
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 24 ]; then
  echo "Automa needs Node.js 24 or newer (found $(node --version)). Run: pkg upgrade -y" >&2
  exit 1
fi

say "Setting up the database"
if [ ! -f "$pgdata/PG_VERSION" ]; then
  mkdir -p "$pgdata"
  initdb "$pgdata" >/dev/null
fi
if ! pg_ctl -D "$pgdata" status >/dev/null 2>&1; then
  pg_ctl -D "$pgdata" -l "$pgdata/server.log" -w start >/dev/null
fi
if ! psql -d postgres -tAc "select 1 from pg_database where datname = 'automa'" | grep -q 1; then
  createdb automa
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
cat > "$PREFIX/bin/automa" <<LAUNCHER
#!$PREFIX/bin/bash
# Starts the Automa database when it is not running, then the Automa server CLI.
# Usage: automa run    (or any paperclipai command: automa doctor, automa onboard)
#        automa adb pair PAIRING-PORT CODE / automa adb connect PORT
#          links this phone's own Wireless debugging, so agents can run adb shell.
set -e
if [ "\${1:-}" = "adb" ]; then
  shift
  command -v adb >/dev/null 2>&1 || pkg install -y android-tools
  case "\${1:-}" in
    pair) exec adb pair "127.0.0.1:\${2:?usage: automa adb pair PAIRING-PORT CODE}" "\${3:?usage: automa adb pair PAIRING-PORT CODE}" ;;
    connect) exec adb connect "127.0.0.1:\${2:?usage: automa adb connect PORT}" ;;
    *) exec adb "\$@" ;;
  esac
fi
if ! pg_ctl -D "$pgdata" status >/dev/null 2>&1; then
  pg_ctl -D "$pgdata" -l "$pgdata/server.log" -w start >/dev/null
fi
export DATABASE_URL="\${DATABASE_URL:-postgres://\$(id -un)@127.0.0.1:5432/automa}"
# A running server holds a wake lock so Android does not pause it.
if [ "\${1:-}" = "run" ] || [ "\${1:-}" = "onboard" ]; then
  command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true
fi
exec node "$server_dir/node_modules/paperclipai/dist/index.js" "\$@"
LAUNCHER
chmod 700 "$PREFIX/bin/automa"

say "Installed. Starting Automa on http://127.0.0.1:3100"
say "Next time, open Termux and run: automa run"
if [ "${AUTOMA_INSTALL_NO_START:-0}" = "1" ]; then
  exit 0
fi
exec automa onboard --yes
