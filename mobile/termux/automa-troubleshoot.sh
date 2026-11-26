#!/data/data/com.termux/files/usr/bin/bash
# `automa troubleshoot` (also `automa fix`): checks what Automa needs on this
# phone, fixes what it safely can, and says what to do about the rest.
#
# It repairs only what Automa itself left behind: a database lock file from a
# Termux that Android ended, an update cut short, a database that isn't
# running, leftover copies and logs when space runs out. It never changes or
# deletes the board's data or its backups.
#
# --start: starts Automa afterwards, in safe mode when it kept stopping while
# it started, and follows it until it is ready. --no-follow (the Automa app's
# Troubleshoot button, which runs this in the background and shows the report)
# starts it without following: the app waits for it itself.
#
# The `automa` launcher passes where everything is (AUTOMA_HOME,
# AUTOMA_SERVER_DIR, AUTOMA_PGDATA, AUTOMA_BACKUP_DIR, AUTOMA_PG_OPTS and
# AUTOMA_COMMAND). AUTOMA_HEALTH_URL and AUTOMA_MEMINFO exist for tests.
set -uo pipefail

automa_home="${AUTOMA_HOME:-$HOME/.automa}"
server_dir="${AUTOMA_SERVER_DIR:-$automa_home/server}"
pgdata="${AUTOMA_PGDATA:-$PREFIX/var/lib/postgresql}"
backup_dir="${AUTOMA_BACKUP_DIR:-${PAPERCLIP_HOME:-$HOME/.paperclip}/instances/${PAPERCLIP_INSTANCE_ID:-default}/data/backups}"
pg_opts="${AUTOMA_PG_OPTS:-}"
automa="${AUTOMA_COMMAND:-automa}"
health_url="${AUTOMA_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
meminfo="${AUTOMA_MEMINFO:-/proc/meminfo}"
entry="node_modules/paperclipai/dist/index.js"
start_after=0
follow=1
for arg in "$@"; do
  case "$arg" in
    --start) start_after=1 ;;
    --no-follow) follow=0 ;;
  esac
done

problems=0
fixes=0
# Colours only on a terminal (Termux); plain text in a log or a pipe.
if [ -t 1 ]; then
  green=$'\033[1;32m' cyan=$'\033[1;36m' yellow=$'\033[1;33m' red=$'\033[1;31m' bold=$'\033[1m' plain=$'\033[0m'
else
  green="" cyan="" yellow="" red="" bold="" plain=""
fi
ok() { printf '  %s✓%s %s\n' "$green" "$plain" "$*"; }
fixed() { printf '  %s✓ Fixed:%s %s\n' "$cyan" "$plain" "$*"; fixes=$((fixes + 1)); }
note() { printf '  %s!%s %s\n' "$yellow" "$plain" "$*"; }
bad() { printf '  %s✗%s %s\n' "$red" "$plain" "$*"; problems=$((problems + 1)); }
hint() { printf '      %s\n' "$*"; }
section() { printf '\n%s%s%s\n' "$bold" "$*" "$plain"; }

# Megabytes a folder takes, for what a clean-up frees.
size_mb() { du -sm "$1" 2>/dev/null | awk '{ print $1 + 0 }'; }
# Whether a file or folder was last changed more than $2 minutes ago (no
# install still writing it).
older_than() { [ -n "$(find "$1" -maxdepth 0 -mmin "+$2" 2>/dev/null)" ]; }

echo "Automa troubleshooter: checking Termux, storage, the server files, the database and Automa itself."

# The last logs, read before anything is cleaned up (freeing space removes the
# previous start's log, which holds the error that stopped it).
logs="$( { tail -n 300 "$automa_home/server.log.1" 2>/dev/null; tail -n 300 "$automa_home/server.log" 2>/dev/null; } )"

section "Termux"
if command -v node >/dev/null 2>&1; then
  # 24.11 or newer: the server refuses an older one as it starts.
  node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  node_major="$(printf '%s' "$node_version" | cut -d. -f1 | tr -dc '0-9')"
  node_minor="$(printf '%s' "$node_version" | cut -d. -f2 | tr -dc '0-9')"
  if [ -n "$node_major" ] && { [ "$node_major" -gt 24 ] || { [ "$node_major" -eq 24 ] && [ "${node_minor:-0}" -ge 11 ]; }; }; then
    ok "Node.js v$node_version"
  else
    bad "Automa needs Node.js 24.11 or newer (this Termux has ${node_version:+v}${node_version:-an unknown version})."
    hint "Run: pkg upgrade -y"
  fi
else
  bad "Node.js is not installed."
  hint "Run: pkg install -y nodejs-lts"
fi
if command -v pg_ctl >/dev/null 2>&1; then
  ok "PostgreSQL $(pg_ctl --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)?' | head -n 1)"
else
  bad "PostgreSQL is not installed."
  hint "Run: pkg install -y postgresql"
fi

section "Storage and memory"
# What is safe to remove: an update cut short (the installer removes these
# when it can), the previous start's log, npm's unfinished downloads and its
# logs, the package files Termux downloaded (what is installed stays), and
# npm's download cache (the next update downloads again).
free_mb_now() { df -Pk "$HOME" 2>/dev/null | awk 'NR == 2 { print int($4 / 1024) }'; }
free_up_space() {
  local dir freed before now
  for dir in "$server_dir.next" "$server_dir.prev" "${TMPDIR:-$PREFIX/tmp}/automa-server"; do
    [ -d "$dir" ] || continue
    # A running install uses these: only ones untouched for two hours go.
    older_than "$dir" 120 || continue
    freed="$(size_mb "$dir")"
    if rm -rf "$dir"; then fixed "Removed $dir, left by an update (${freed:-0} MB)."; fi
  done
  if [ -f "$automa_home/server.log.1" ]; then
    rm -f "$automa_home/server.log.1" && fixed "Removed the previous start's log."
  fi
  for dir in "$HOME/.npm/_cacache/tmp" "$HOME/.npm/_logs"; do
    [ -d "$dir" ] || continue
    freed="$(size_mb "$dir")"
    if rm -rf "$dir" && [ "${freed:-0}" -gt 0 ]; then fixed "Removed npm's unfinished downloads and logs in $dir ($freed MB)."; fi
  done
  if command -v apt-get >/dev/null 2>&1; then
    before="$(free_mb_now)"
    apt-get clean >/dev/null 2>&1 || true
    now="$(free_mb_now)"
    # Said only when it really gained room.
    if [ -n "$before" ] && [ -n "$now" ] && [ "$now" -gt "$before" ]; then fixed "Removed the package files Termux had downloaded ($((now - before)) MB; what is installed stays)."; fi
  fi
  if command -v npm >/dev/null 2>&1 && [ -d "$HOME/.npm/_cacache" ]; then
    freed="$(size_mb "$HOME/.npm/_cacache")"
    if npm cache clean --force >/dev/null 2>&1; then fixed "Emptied npm's download cache (${freed:-0} MB; the next update downloads again)."; fi
  fi
}
# What an update needs, measured the way the installer measures it: the new
# server is prepared next to the one in use, so room for a second copy of it,
# and 300 MB to work in.
server_mb="$(size_mb "$server_dir")"
update_need_mb=$(( ${server_mb:-0} + ${AUTOMA_UPDATE_HEADROOM_MB:-300} ))
free_kb="$(df -Pk "$HOME" 2>/dev/null | awk 'NR == 2 { print $4 }' | tr -dc '0-9')"
if [ -n "$free_kb" ]; then
  free_mb=$((free_kb / 1024))
  if [ "$free_mb" -lt 300 ]; then
    bad "Only $free_mb MB of storage is free. The database and Automa stop working when the phone runs out of space."
    free_up_space
    free_kb="$(df -Pk "$HOME" 2>/dev/null | awk 'NR == 2 { print $4 }' | tr -dc '0-9')"
    [ -z "$free_kb" ] || hint "Now $((free_kb / 1024)) MB free (an update needs about $update_need_mb MB). Deleting photos, videos or apps you don't use frees more."
  elif [ "$free_mb" -lt "$update_need_mb" ]; then
    note "$free_mb MB of storage free: not enough for an update, which needs about $update_need_mb MB (the new server is prepared next to the one in use). Deleting photos, videos or apps you don't use makes room."
  elif [ "$free_mb" -lt 1024 ]; then
    note "$free_mb MB of storage free: getting low."
  else
    ok "$free_mb MB of storage free"
  fi
fi
if [ -d "$backup_dir" ]; then
  backups_mb="$(size_mb "$backup_dir")"
  [ -z "$backups_mb" ] || [ "$backups_mb" -lt 1024 ] || note "Backups take $backups_mb MB in $backup_dir (Automa keeps them; delete old ones there if you need the space)."
fi
avail_kb="$(awk '/^MemAvailable:/ { print $2 }' "$meminfo" 2>/dev/null | tr -dc '0-9')"
if [ -n "$avail_kb" ]; then
  avail_mb=$((avail_kb / 1024))
  if [ "$avail_mb" -lt 400 ]; then
    note "Only $avail_mb MB of memory is free. Android ends apps in the background (Termux too) when memory runs low: close apps you aren't using."
  else
    ok "$avail_mb MB of memory free"
  fi
fi

section "Automa's server files"
if [ -f "$server_dir/$entry" ]; then
  ok "Automa $(cat "$server_dir/.automa-version" 2>/dev/null || echo '(version unknown)') is installed"
  # An update that stopped right after the switch leaves the old copy behind.
  if [ -d "$server_dir.prev" ] && older_than "$server_dir.prev" 120; then
    freed="$(size_mb "$server_dir.prev")"
    rm -rf "$server_dir.prev" && fixed "Removed the copy of the old server an update left behind (${freed:-0} MB)."
  fi
elif [ -f "$server_dir.next/$entry" ] && [ -f "$server_dir.next/.automa-version" ]; then
  # The update had finished downloading (its version is written last) and
  # stopped just before taking the old server's place.
  rm -rf "$server_dir" && mv "$server_dir.next" "$server_dir" &&
    fixed "An update stopped just before it finished; Automa $(cat "$server_dir/.automa-version") is now in place."
elif [ -f "$server_dir.prev/$entry" ]; then
  rm -rf "$server_dir" && mv "$server_dir.prev" "$server_dir" &&
    fixed "An update stopped halfway; the server from before it is back in place."
else
  bad "Automa's server files are missing or incomplete."
  hint "In the Automa app, open the setup screen and tap Send to Termux, then run: automa update"
fi

section "Database"
db_running=0
if ! command -v pg_ctl >/dev/null 2>&1; then
  bad "Can't check the database without PostgreSQL (see above)."
elif [ ! -f "$pgdata/PG_VERSION" ]; then
  bad "There is no Automa database at $pgdata."
  hint "Run the installer again (automa update), then: automa restore (it puts the newest backup back)."
else
  data_major="$(tr -dc '0-9' < "$pgdata/PG_VERSION")"
  bin_major="$(pg_ctl --version 2>/dev/null | grep -oE '[0-9]+' | head -n 1)"
  if [ -n "$bin_major" ] && [ "$data_major" != "$bin_major" ]; then
    bad "The database was written by PostgreSQL $data_major, but Termux now has PostgreSQL $bin_major, which can't open it."
    hint "Nothing was changed. Either put the matching version back: pkg install postgresql=$data_major*"
    hint "or keep the new one: mv \"$pgdata\" \"$pgdata.pg$data_major\", run the installer again, then: automa restore"
  else
    # PostgreSQL's lock file outlives a Termux that Android ended.
    lock="$pgdata/postmaster.pid"
    if [ -f "$lock" ]; then
      lock_pid="$(head -n 1 "$lock" 2>/dev/null | tr -dc '0-9')"
      if [ -z "$lock_pid" ] || ! { tr '\0' ' ' < "/proc/$lock_pid/cmdline"; } 2>/dev/null | grep -q postgres; then
        rm -f "$lock" && fixed "Cleared PostgreSQL's lock file from before (Android ended Termux without letting it shut down)."
      fi
    fi
    if pg_ctl -D "$pgdata" status >/dev/null 2>&1; then
      db_running=1
      ok "The database is running"
    else
      # shellcheck disable=SC2086
      if { [ -n "$pg_opts" ] && pg_ctl -D "$pgdata" -l "$pgdata/server.log" -o "$pg_opts" -w start >/dev/null 2>&1; } ||
        pg_ctl -D "$pgdata" status >/dev/null 2>&1 ||
        pg_ctl -D "$pgdata" -l "$pgdata/server.log" -w start >/dev/null 2>&1; then
        db_running=1
        fixed "The database wasn't running; it is now."
      else
        bad "The database doesn't start."
        pg_log="$(tail -n 40 "$pgdata/server.log" 2>/dev/null)"
        case "$pg_log" in
          *"No space left"*) hint "It says the phone is out of space (see Storage above)." ;;
          *"shared memory"*) hint "It could not get shared memory: restart the phone, then: automa troubleshoot --start" ;;
          *"already exists"*|*"already running"*) hint "Another PostgreSQL holds it, perhaps in another Termux session: close that session (or restart the phone)." ;;
          *"incompatible"*) hint "Its files are from another PostgreSQL version (see above)." ;;
        esac
        printf '%s\n' "$pg_log" | tail -n 6 | sed 's/^/      | /'
      fi
    fi
    if [ "$db_running" = 1 ] && command -v psql >/dev/null 2>&1; then
      export PGPASSWORD="$(cat "$automa_home/db-password" 2>/dev/null)"
      if db_error="$(psql -h 127.0.0.1 -d automa -tAc 'select 1' 2>&1 >/dev/null)"; then
        ok "Automa's database answers"
      elif printf '%s' "$db_error" | grep -q 'password authentication failed'; then
        bad "The database refused Automa's password ($automa_home/db-password)."
        hint "If you changed it: alter user \"$(id -un)\" with password '<the one in that file>'; in psql."
      elif printf '%s' "$db_error" | grep -q 'does not exist'; then
        bad "The automa database is missing (a restore that stopped halfway?)."
        hint "automa restore puts the newest backup back."
      else
        bad "The database doesn't answer: $(printf '%s' "$db_error" | head -n 1)"
      fi
    fi
  fi
fi
newest="$(ls -t "$backup_dir"/*.sql.gz 2>/dev/null | head -n 1)"
if [ -n "$newest" ]; then
  ok "Newest backup: $(basename "$newest") ($(date -r "$newest" '+%Y-%m-%d %H:%M' 2>/dev/null))"
else
  note "No backup yet. automa backup makes one (Automa also saves one every hour while it runs)."
fi

section "Automa"
# One word for what answers on Automa's port: ready, safe:<reason>,
# starting:<step>, http-<status>, or silent.
state="$(node -e '
  fetch(process.argv[1], { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8600) })
    .then(async (res) => {
      const body = await res.json().catch(() => null);
      if (res.ok && body && body.safeMode) return console.log(`safe:${body.safeModeReason || "asked"}`);
      if (res.ok && body && body.status === "ok") return console.log("ready");
      if (res.ok && body && body.status === "starting") return console.log(`starting:${body.startup?.step?.label || ""}`);
      console.log(`http-${res.status}`);
    }, () => console.log("silent"));
' "$health_url" 2>/dev/null)"
launcher_pid=""
if pid="$(cat "$automa_home/automa.pid" 2>/dev/null)" && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null &&
  { tr '\0' ' ' < "/proc/$pid/cmdline"; } 2>/dev/null | grep -q automa; then
  launcher_pid="$pid"
fi
case "$state" in
  ready) ok "Automa is running and ready on http://127.0.0.1:3100" ;;
  safe:crashes)
    note "Automa is running in safe mode, because it kept stopping while it started: agents, schedules and plugins are off."
    hint "Once what's marked here is fixed: Restart normally on the board's banner, or: automa restart" ;;
  safe:*)
    note "Automa is running in safe mode (asked for): agents, schedules and plugins are off."
    hint "Restart normally on the board's banner, or: automa restart" ;;
  starting:*)
    label="${state#starting:}"
    ok "Automa is starting up${label:+: $label}" ;;
  http-*) bad "Something answers on Automa's port (3100) but not like Automa (${state})." ;;
  *)
    if node -e 'const s = require("net").connect(3100, "127.0.0.1"); s.on("connect", () => process.exit(0)); s.on("error", () => process.exit(1)); setTimeout(() => process.exit(1), 3000);' 2>/dev/null; then
      bad "Something holds Automa's port (3100) but doesn't answer: a stuck Automa, or another program."
      hint "automa restart stops and starts Automa; if that doesn't help, restart the phone."
    elif [ -n "$launcher_pid" ]; then
      note "Automa isn't answering yet; its launcher is running and starts it again when it stops."
    else
      note "Automa isn't running."
    fi ;;
esac

events="$automa_home/events.log"
android_ended=0
fell_back=0
if [ -s "$events" ]; then
  recent="$(tail -n 40 "$events")"
  android_ended="$(printf '%s\n' "$recent" | grep -cE 'exit code 137|without warning')"
  memory_crashes="$(printf '%s\n' "$recent" | grep -c 'exit code 134')"
  # How the last start ended up: it fell back to safe mode after stopping
  # again and again, and nothing started it normally since.
  last_mode="$(grep -E 'falling back to safe mode|restarting normally|started$' "$events" | tail -n 1)"
  case "$last_mode" in *"falling back to safe mode"*) fell_back=1 ;; esac
  [ "$android_ended" -eq 0 ] || bad "Android ended Automa without warning $android_ended time(s) recently (see Android below)."
  [ "$memory_crashes" -eq 0 ] || note "Automa crashed $memory_crashes time(s) recently, most often from running out of memory."
  printf '      Recent starts and stops (%s):\n' "$events"
  tail -n 5 "$events" | sed 's/^/      | /'
fi

# What the last logs (read at the start) say went wrong, once per kind.
if [ -n "$logs" ]; then
  seen=""
  explain_log() {
    local pattern="$1" message="$2" advice="$3"
    printf '%s' "$logs" | grep -qE "$pattern" || return 0
    case "$seen" in *"|$message|"*) return 0 ;; esac
    seen="$seen|$message|"
    bad "The log says: $message"
    hint "$advice"
  }
  explain_log 'EADDRINUSE' "port 3100 was taken by something else." "automa restart; if it keeps happening, restart the phone."
  explain_log 'ENOSPC|No space left on device' "the phone ran out of storage." "See Storage above."
  explain_log 'heap out of memory|Allocation failed' "Automa ran out of memory." "Close other apps; safe mode (automa restart --safe) uses much less."
  explain_log 'ECONNREFUSED[^ ]* 127\.0\.0\.1:5432|database system is (starting up|shutting down)' "the database wasn't reachable." "See Database above; automa troubleshoot --start starts both."
  explain_log 'password authentication failed' "the database refused Automa's password." "See Database above."
  explain_log 'Cannot find module|ERR_MODULE_NOT_FOUND' "part of Automa's server is missing." "In the Automa app, open the setup screen, tap Send to Termux, then run: automa update"
  # Refused, not failed: the server stopped before applying the new version's
  # migrations (asked on a terminal, where Enter means No). Starting it through
  # the launcher applies them, so going back to a backup would not help.
  explain_log 'Refusing to start against a stale schema' "the new version's database changes were not applied yet, so Automa did not start." "Starting Automa applies them; the copy of the database from before the update is in $backup_dir. Run: automa run"
  explain_log 'applyPendingMigrations|Failed to (apply pending|bootstrap) migrations' "updating the database to this version failed." "automa restore lists backups; the one named automa-before-<version> is from just before the update."
  explain_log 'EACCES|[Pp]ermission denied' "something wasn't allowed to read or write a file." "Run: termux-setup-storage only if Automa asked for your phone's storage; otherwise automa update repairs the files."
fi

section "Android"
sdk="$(getprop ro.build.version.sdk 2>/dev/null | tr -dc '0-9')"
release="$(getprop ro.build.version.release 2>/dev/null | tr -d '\r')"
if [ -n "$sdk" ] && [ "$sdk" -ge 31 ]; then
  if [ -s "$automa_home/keep-alive" ]; then
    ok "Android $release's limit on background processes is lifted (automa keep-alive)"
  else
    if [ "$android_ended" -gt 0 ]; then
      bad "Android $release ends Termux's processes when apps together run too many (that is what stopped Automa)."
    else
      note "Android $release can end Termux's processes when apps together run too many (agents add several each)."
    fi
    hint "Run: automa keep-alive (it uses Wireless debugging once; the setting stays after restarts)"
    [ "$sdk" -lt 34 ] || hint "Or by hand: Settings → Developer options → Disable child process restrictions"
  fi
elif [ -n "$sdk" ]; then
  ok "Android $release has no limit on background processes"
fi
command -v termux-wake-lock >/dev/null 2>&1 && ok "Automa keeps Termux awake while it runs (wake lock)"
if [ -f "$HOME/.termux/boot/automa" ]; then
  ok "Automa starts when the phone does, with the Termux:Boot app installed"
fi
hint "Battery: Settings → Apps → Termux → Battery → Unrestricted keeps Android from pausing Termux."

section "Summary"
also=""
[ "$fixes" -eq 0 ] || also=" Fixed $fixes thing(s) along the way."
if [ "$problems" -eq 0 ]; then
  echo "No problems found.$also"
else
  echo "$problems problem(s) need you (marked ✗ above).$also"
fi

if [ "$start_after" = 1 ]; then
  echo
  case "$state" in
    ready|safe:*|starting:*) echo "Automa is already running." ;;
    *)
      mode=""
      # It kept stopping while it started: safe mode opens the board without
      # what may be the cause (agents, schedules, plugins).
      [ "$fell_back" -eq 0 ] || mode="--safe"
      [ -z "$mode" ] || echo "Automa kept stopping while it started, so it starts in safe mode."
      "$automa" start $mode
      if [ "$follow" = 1 ] && node "$automa_home/bin/automa-follow-start.mjs"; then
        command -v am >/dev/null 2>&1 && am start -n com.corxlabs.automa/.MainActivity >/dev/null 2>&1
        echo "Switch back to the Automa app: it connects by itself."
      fi ;;
  esac
fi
[ "$problems" -eq 0 ]
