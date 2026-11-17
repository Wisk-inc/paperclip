#!/data/data/com.termux/files/usr/bin/bash
# `automa keep-alive`: stops Android from ending Termux, and Automa with it.
#
# Android 12 and newer end the background processes of apps once all apps
# together run more than 32 of them ("phantom processes"), or one uses a lot
# of CPU in the background. Termux then shows
# "[Process completed (signal 9) - press Enter]" and Automa stops, often while
# agents are working (each agent is several processes). Only adb may lift that
# limit, so this links adb to the phone itself when it isn't linked yet
# (automa adb link: Wireless debugging), then, as Termux documents:
#   Android 12L and newer: settings put global settings_enable_monitor_phantom_procs false
#     (Android 14 and newer also show it in Developer options as
#     "Disable child process restrictions")
#   Android 12: device_config set_sync_disabled_for_tests persistent and
#     device_config put activity_manager max_phantom_processes 2147483647
#   every version: Termux off battery optimisation (dumpsys deviceidle
#     whitelist +com.termux) and allowed to run in the background (appops).
# Each change is read back before it is reported. They stay after restarts.
# `automa keep-alive --check` only says whether it was done.
set -uo pipefail

automa_home="${AUTOMA_HOME:-$HOME/.automa}"
marker="$automa_home/keep-alive"
TERMUX_PACKAGE="com.termux"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok() { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

sdk="$(getprop ro.build.version.sdk 2>/dev/null | tr -dc '0-9')"
release="$(getprop ro.build.version.release 2>/dev/null | tr -d '\r')"

if [ "${1:-}" = "--check" ]; then
  if [ -s "$marker" ]; then
    say "Done before: $(tr '\n' ' ' < "$marker")"
    exit 0
  fi
  if [ -n "$sdk" ] && [ "$sdk" -lt 31 ]; then
    say "Android ${release:-$sdk} has no limit on background processes: nothing to lift."
    exit 0
  fi
  warn "Not done yet on this phone. Run: automa keep-alive"
  exit 1
fi

if [ -n "$sdk" ] && [ "$sdk" -lt 31 ]; then
  say "Android ${release:-$sdk} has no limit on background processes; only battery optimisation can still pause Termux."
fi

command -v adb >/dev/null 2>&1 || {
  say "Installing adb (android-tools)"
  bash "$automa_home/bin/automa-pkg-install" android-tools || fail "Could not install adb. Run: pkg install android-tools, then automa keep-alive"
}

# The phone itself, as adb sees it. Wireless debugging can list it twice (by
# address and by its mDNS name); either one is this phone.
device() { adb devices 2>/dev/null | awk 'NR > 1 && $2 == "device" { print $1; exit }'; }

serial="$(device)"
if [ -z "$serial" ]; then
  if { : </dev/tty; } 2>/dev/null; then
    say "Android lets only Wireless debugging lift this limit. Linking it first (the same as automa adb link)."
    bash "$automa_home/bin/automa-adb-link" || fail "Wireless debugging is not linked, so nothing changed. Run automa keep-alive again once automa adb link works."
    serial="$(device)"
  fi
  if [ -z "$serial" ]; then
    warn "Wireless debugging is not linked, so nothing changed."
    if [ -n "$sdk" ] && [ "$sdk" -ge 34 ]; then
      warn "On this phone you can also do it by hand: Settings → Developer options → Disable child process restrictions."
    fi
    fail "Run automa keep-alive in the Termux app: it walks you through linking Wireless debugging (once)."
  fi
fi

shell() { adb -s "$serial" shell "$@" 2>&1 | tr -d '\r'; }
[ -n "$sdk" ] || sdk="$(shell getprop ro.build.version.sdk | tr -dc '0-9')"
[ -n "$release" ] || release="$(shell getprop ro.build.version.release)"
[ -n "$sdk" ] || fail "Could not read this phone's Android version over adb ($serial)."
say "Android $release (SDK $sdk), linked as $serial"

lifted=""
# Android 12 keeps the limit in device_config, which Google's servers can reset
# unless syncing it is turned off; 12L and newer have a switch that turns the
# monitor off. When the switch doesn't take, the device_config way is the fallback.
lift_with_device_config() {
  shell /system/bin/device_config set_sync_disabled_for_tests persistent >/dev/null
  shell /system/bin/device_config put activity_manager max_phantom_processes 2147483647 >/dev/null
  [ "$(shell /system/bin/device_config get activity_manager max_phantom_processes)" = "2147483647" ]
}
if [ "$sdk" -ge 32 ]; then
  shell settings put global settings_enable_monitor_phantom_procs false >/dev/null
  if [ "$(shell settings get global settings_enable_monitor_phantom_procs)" = "false" ]; then
    lifted="settings_enable_monitor_phantom_procs=false"
    ok "Android no longer ends Termux for running too many processes"
  elif lift_with_device_config; then
    lifted="max_phantom_processes=2147483647"
    ok "Android no longer ends Termux for running too many processes (through device_config)"
  else
    warn "Android did not take the change; Termux can still be ended for running too many processes."
    [ "$sdk" -ge 34 ] && warn "Try by hand: Settings → Developer options → Disable child process restrictions."
  fi
elif [ "$sdk" -ge 31 ]; then
  if lift_with_device_config; then
    lifted="max_phantom_processes=2147483647"
    ok "Android no longer ends Termux for running too many processes"
  else
    warn "Android did not take the change; Termux can still be ended for running too many processes."
  fi
else
  lifted="no limit on this Android"
fi

# Battery optimisation pauses Termux in the background on every Android.
shell dumpsys deviceidle whitelist "+$TERMUX_PACKAGE" >/dev/null
shell cmd appops set "$TERMUX_PACKAGE" RUN_ANY_IN_BACKGROUND allow >/dev/null
battery=""
if shell dumpsys deviceidle whitelist | grep -q "$TERMUX_PACKAGE"; then
  battery="termux-battery-unrestricted"
  ok "Battery optimisation is off for Termux, so Android doesn't pause it"
else
  warn "Could not take Termux off battery optimisation: Settings → Apps → Termux → Battery → Unrestricted does the same."
fi

if [ -z "$lifted" ]; then
  fail "The process limit is still on. Nothing was recorded; run automa keep-alive again, or use the Developer options switch above."
fi
mkdir -p "$automa_home"
{
  printf 'android=%s sdk=%s\n' "$release" "$sdk"
  printf 'process_limit=%s\n' "$lifted"
  [ -z "$battery" ] || printf 'battery=%s\n' "$battery"
  printf 'done=%s\n' "$(date '+%Y-%m-%d %H:%M')"
} > "$marker"
say "Done. These settings stay after the phone restarts; Wireless debugging can be turned off again."
