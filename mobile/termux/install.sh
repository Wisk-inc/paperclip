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
# Where Automa keeps its own hourly database backups (the server writes them
# while it runs); the installer and `automa backup` add theirs here too.
backup_dir="${PAPERCLIP_HOME:-$HOME/.paperclip}/instances/${PAPERCLIP_INSTANCE_ID:-default}/data/backups"
version="$(cat "$here/VERSION")"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

if [ -z "${PREFIX:-}" ] || [ ! -d "$PREFIX/bin" ]; then
  echo "Run this inside the Termux app." >&2
  exit 1
fi

# Package installs that survive Android clearing apt's download cache in the
# middle of a download (the install then ends with "rename failed, No such file
# or directory" after the whole package arrived): make the folder apt really
# uses, and when the install still fails, install again with a download folder
# inside Termux's own files. Kept as a command for the `automa` launcher too.
mkdir -p "$automa_home/bin"
cat > "$automa_home/bin/automa-pkg-install" <<'PKGINSTALL'
#!/data/data/com.termux/files/usr/bin/bash
# automa-pkg-install <package>...: `pkg install -y` that survives Android
# clearing apt's download cache mid-download ("rename failed").
archives=""
eval "$(apt-config shell archives Dir::Cache::archives/d 2>/dev/null)" 2>/dev/null || archives=""
[ -n "$archives" ] || archives="$PREFIX/../../cache/apt/archives"
mkdir -p "${archives%/}/partial" 2>/dev/null || true
pkg install -y "$@" && exit 0
echo "==> The install was interrupted; trying again with Automa's own download folder" >&2
cache="$PREFIX/var/cache/automa-apt"
mkdir -p "$cache/archives/partial"
apt-get update || true
for attempt in 1 2; do
  if apt-get -o Dir::Cache::archives="$cache/archives/" -o Acquire::Retries=3 install -y --fix-missing "$@"; then
    rm -rf "$cache"
    exit 0
  fi
  sleep 3
done
rm -rf "$cache"
exit 1
PKGINSTALL
chmod 700 "$automa_home/bin/automa-pkg-install"
termux_pkg_install() { bash "$automa_home/bin/automa-pkg-install" "$@"; }

# Keep Android from pausing Termux in the background while this runs.
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
  trap 'command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock || true' EXIT
fi

say "Checking Node.js and PostgreSQL"
# Only what is missing: installing postgresql while it is there upgrades it, and
# a new major version cannot open the database (see the check below).
missing=""
command -v node >/dev/null 2>&1 || missing="nodejs-lts"
command -v pg_ctl >/dev/null 2>&1 || missing="$missing postgresql"
if [ -n "$missing" ]; then
  # git: tasks that use a project repository check it out before the agent runs.
  # shellcheck disable=SC2086
  termux_pkg_install $missing git
fi
# python: the Terminals page's PTY relay. proot-distro: the small Debian layer
# Claude Code and Codex run in on a phone. Both small; the layer itself is set
# up from the Terminals page the first time it's needed.
for tool in python proot-distro; do
  command -v "$tool" >/dev/null 2>&1 || termux_pkg_install "$tool" || echo "Could not install $tool now; Terminals will offer to later." >&2
done
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
pg_major="$(pg_ctl --version | grep -oE '[0-9]+' | head -n 1)"
if [ -f "$pgdata/PG_VERSION" ] && [ "$(cat "$pgdata/PG_VERSION")" != "$pg_major" ]; then
  # Termux upgraded PostgreSQL across a major version (pkg upgrade). The new
  # server cannot open the old files, and this installer never replaces them:
  # they are the board, the chats and the agents.
  cat >&2 <<MISMATCH
Your Automa database was written by PostgreSQL $(cat "$pgdata/PG_VERSION"), but Termux now has PostgreSQL $pg_major.
Nothing was changed. To keep your data:
  1. Find the newest backup:   ls -t $backup_dir | head
     (Automa saves one every hour while it runs; each is a complete copy.)
  2. Move the old files aside:  mv "$pgdata" "$pgdata.pg$(cat "$pgdata/PG_VERSION")"
  3. Run this installer again, then:  automa restore
     (it offers the newest backup).
If there is no backup, install the matching postgresql package back
(pkg install postgresql=$(cat "$pgdata/PG_VERSION")*) and run: automa backup
MISMATCH
  exit 1
fi
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
    # A complete copy of the database first, so an update can never cost the
    # board. `automa restore` lists these.
    if psql -h 127.0.0.1 -d automa -tAc "select 1" >/dev/null 2>&1; then
      mkdir -p "$backup_dir"
      pre_update_backup="$backup_dir/automa-before-$version-$(date +%Y%m%d-%H%M%S).sql.gz"
      if pg_dump -h 127.0.0.1 --format=plain --clean --if-exists --no-owner --no-privileges automa | gzip > "$pre_update_backup"; then
        say "Database backed up to $pre_update_backup"
      else
        rm -f "$pre_update_backup"
        echo "Could not back up the database; continuing without a fresh backup (automa restore lists the hourly ones)." >&2
      fi
    fi
  else
    say "Installing the Automa server $version"
    say "The first install downloads about 380 packages: 10 to 45 minutes depending on your connection."
    say "npm stays quiet until it finishes. Keep Termux open and the phone on charge."
  fi
  # The app ships the packages unpacked (xz-compressed); npm installs tarballs.
  # A running Automa keeps the old code loaded (and npm would replace files
  # under it), so stop it first; the new server starts at the end of this install.
  if [ -s "$automa_home/automa.pid" ] && kill -0 "$(cat "$automa_home/automa.pid")" 2>/dev/null; then
    say "Stopping the running Automa server so the update takes effect"
    kill -TERM "$(cat "$automa_home/automa.pid")" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$(cat "$automa_home/automa.pid")" 2>/dev/null || break; sleep 1; done
    rm -f "$automa_home/automa.pid"
  fi
  if node -e "fetch('http://127.0.0.1:3100/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
    echo "An Automa server is still running (started in another Termux session?). Stop it there with Ctrl+C, or the old version keeps answering until the phone restarts." >&2
  fi
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
#        automa update     installs the newer server the Automa app sent (~/downloads/automa-server.tar.xz)
#        automa backup     saves a complete copy of the database (Automa also saves one every hour)
#        automa restore    puts a backup back (lists them; pass a file to pick one)
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
  am start -a android.intent.action.MAIN -n com.corxlabs.automa/.MainActivity \\
    --es com.corxlabs.automa.CONNECT http://127.0.0.1:3100 \\
    --es com.corxlabs.automa.SECRET "\$PAPERCLIP_LOCAL_TRUSTED_SECRET" >/dev/null 2>&1
}
# A complete copy of the database in \$1. It is written beside it first, so a
# dump that fails (no space left, say) never leaves a file that looks like a backup.
dump_db() {
  if ( set -o pipefail; pg_dump -h 127.0.0.1 --format=plain --clean --if-exists --no-owner --no-privileges automa | gzip > "\$1.part" ); then
    mv "\$1.part" "\$1"
  else
    rm -f "\$1.part"
    return 1
  fi
}
# A backup restore can use: whole, and a dump that ran to its end (pg_dump's
# closing line, or the COMMIT that ends Automa's own hourly backups).
backup_ok() {
  local end
  end="\$(set -o pipefail; gunzip -c "\$1" 2>/dev/null | tail -n 20)" || return 1
  printf '%s\n' "\$end" | grep -Eq '^(-- PostgreSQL database dump complete|COMMIT;)'
}
case "\${1:-}" in
  adb)
    shift
    command -v adb >/dev/null 2>&1 || bash "$automa_home/bin/automa-pkg-install" android-tools
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
  update)
    # The app saves its bundled server as ~/downloads/automa-server.tar.xz
    # (Send to Termux). Its installer updates in place and keeps the data.
    bundle="\$HOME/downloads/automa-server.tar.xz"
    [ -s "\$bundle" ] || { echo "No new server to install. In the Automa app, open the setup screen and tap Send to Termux, then run: automa update" >&2; exit 1; }
    tmp="\${TMPDIR:-$PREFIX/tmp}"
    rm -rf "\$tmp/automa-server"
    tar -xf "\$bundle" -C "\$tmp"
    exec bash "\$tmp/automa-server/install.sh"
    ;;
  backup)
    # Same shape as the server's hourly backups, so automa restore reads both.
    pg_ctl -D "$pgdata" status >/dev/null 2>&1 || pg_ctl -D "$pgdata" -l "$pgdata/server.log" -w start >/dev/null
    export PGPASSWORD="\$(cat "$db_password_file")"
    mkdir -p "$backup_dir"
    file="$backup_dir/automa-manual-\$(date +%Y%m%d-%H%M%S).sql.gz"
    dump_db "\$file" || { echo "Could not back up the database (is there free space?). No backup was saved." >&2; exit 1; }
    echo "Database backed up to \$file"
    exit 0
    ;;
  restore)
    # Puts a backup back in place of the current database. Destructive, so it
    # says what it will replace and asks first (automa restore FILE --yes skips the question).
    pg_ctl -D "$pgdata" status >/dev/null 2>&1 || pg_ctl -D "$pgdata" -l "$pgdata/server.log" -w start >/dev/null
    export PGPASSWORD="\$(cat "$db_password_file")"
    file="\${2:-}"
    if [ "\$file" = "--yes" ]; then file=""; fi
    if [ -z "\$file" ]; then
      echo "Backups (newest first) in $backup_dir:"
      ls -t "$backup_dir"/*.sql.gz 2>/dev/null | head -n 10 | while read -r f; do printf '  %s  (%s)\n' "\$f" "\$(du -h "\$f" | cut -f1)"; done
      # A backup cut short (the phone ran out of space mid-way, say) is passed over.
      file="\$(ls -t "$backup_dir"/*.sql.gz 2>/dev/null | while read -r f; do if backup_ok "\$f"; then echo "\$f"; break; fi; echo "Skipping \$f: it is not a complete backup." >&2; done)"
      [ -n "\$file" ] || { echo "No complete backup yet. automa backup makes one; Automa saves one every hour while it runs." >&2; exit 1; }
      echo "Newest complete backup: \$file"
    elif [ ! -s "\$file" ]; then
      echo "No such backup: \$file" >&2
      exit 1
    elif ! backup_ok "\$file"; then
      echo "\$file is not a complete backup (it was cut short or is damaged). Nothing changed." >&2
      exit 1
    fi
    if [ "\${2:-}" != "--yes" ] && [ "\${3:-}" != "--yes" ]; then
      printf 'Replace the current Automa database with %s? Type yes to continue: ' "\$file"
      read -r answer
      [ "\$answer" = "yes" ] || { echo "Nothing changed."; exit 1; }
    fi
    # Keep what is there now, so a restore can itself be undone; without that
    # copy nothing is replaced.
    mkdir -p "$backup_dir"
    before=""
    if psql -h 127.0.0.1 -d postgres -tAc "select 1 from pg_database where datname = 'automa'" | grep -q 1; then
      before="$backup_dir/automa-before-restore-\$(date +%Y%m%d-%H%M%S).sql.gz"
      dump_db "\$before" || { echo "Could not save a copy of the current database first (is there free space?). Nothing changed." >&2; exit 1; }
    fi
    # Automa must be down while its database is swapped: one started by
    # automa start/run stops here, one started some other way must be stopped first.
    pid="\$(cat "$automa_home/automa.pid" 2>/dev/null || true)"
    "\$0" stop >/dev/null 2>&1 || true
    for _ in \$(seq 1 30); do { [ -n "\$pid" ] && kill -0 "\$pid" 2>/dev/null; } || break; sleep 1; done
    if node -e "fetch('http://127.0.0.1:3100/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
      echo "Automa is still running (started in another Termux session?). Stop it there with Ctrl+C, then run automa restore again. Nothing changed." >&2
      exit 1
    fi
    psql -h 127.0.0.1 -d postgres -tAc "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'automa' and pid <> pg_backend_pid()" >/dev/null || true
    dropdb -h 127.0.0.1 --if-exists automa
    createdb -h 127.0.0.1 automa
    gunzip -c "\$file" | psql -h 127.0.0.1 -d automa --quiet --no-psqlrc --set=ON_ERROR_STOP=0 >/dev/null
    echo "Restored \$file."
    [ -z "\$before" ] || echo "The copy from before this restore is \$before"
    echo "Start Automa again with: automa run"
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
# Automa sends no usage data anywhere: the upstream telemetry endpoint belongs
# to another company. Set PAPERCLIP_TELEMETRY_DISABLED=0 to opt back in.
export PAPERCLIP_TELEMETRY_DISABLED="\${PAPERCLIP_TELEMETRY_DISABLED:-1}"
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
touch "$HOME/.termux/termux.properties"
if ! grep -qs '^[[:space:]]*allow-external-apps[[:space:]]*=[[:space:]]*true' "$HOME/.termux/termux.properties"; then
  # Replace any "= false" line rather than leaving Termux two answers.
  sed -i '/^[[:space:]]*allow-external-apps/d' "$HOME/.termux/termux.properties"
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
