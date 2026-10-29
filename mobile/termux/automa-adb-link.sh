#!/data/data/com.termux/files/usr/bin/bash
# `automa adb link`: links this phone's own Wireless debugging to adb in Termux,
# so agents can run `adb shell` (input, screencap, pm, settings) on the phone.
#
# Two numbers are involved and they look alike, which is where most people get
# stuck: the PAIRING port and 6-digit CODE from "Pair device with pairing code",
# then the CONNECTION port from the Wireless debugging screen itself. Both
# change every time the screen is opened. This script finds them over mDNS when
# it can, asks for what it can't, and checks each answer before using it.
set -euo pipefail

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

ask() {
  local answer
  read -r -p "$1" answer </dev/tty
  printf '%s' "$answer"
}

# `pkg install -y` that survives Android clearing apt's download cache in the
# middle of a download ("rename failed, No such file or directory"): make the
# folder apt really uses, then retry with a download folder inside Termux's
# own files.
termux_pkg_install() {
  local archives="" cache="$PREFIX/var/cache/automa-apt" attempt
  eval "$(apt-config shell archives Dir::Cache::archives/d 2>/dev/null)" 2>/dev/null || archives=""
  [ -n "$archives" ] || archives="$PREFIX/../../cache/apt/archives"
  mkdir -p "${archives%/}/partial" 2>/dev/null || true
  pkg install -y "$@" && return 0
  say "The install was interrupted; trying again with Automa's own download folder"
  mkdir -p "$cache/archives/partial"
  apt-get update || true
  for attempt in 1 2; do
    if apt-get -o Dir::Cache::archives="$cache/archives/" -o Acquire::Retries=3 install -y --fix-missing "$@"; then
      rm -rf "$cache"
      return 0
    fi
    sleep 3
  done
  rm -rf "$cache"
  return 1
}

command -v adb >/dev/null 2>&1 || { say "Installing adb (android-tools)"; termux_pkg_install android-tools; }

# Already linked? Nothing to do.
if adb devices 2>/dev/null | awk 'NR > 1 && $2 == "device"' | grep -q .; then
  say "This phone is already linked:"
  adb devices
  say "Agents can run: adb shell <command>"
  exit 0
fi

# This phone's Wi-Fi address, for addresses typed as a port alone.
phone_ip() {
  node -e 'const n=require("os").networkInterfaces();for(const [k,v] of Object.entries(n)){if(!/^(wlan|eth)/.test(k))continue;for(const a of v){if(a.family==="IPv4"&&!a.internal){console.log(a.address);process.exit(0)}}}' 2>/dev/null || true
}

# "IP:PORT" as shown on the phone, or just the port: returns IP:PORT or fails.
# $2 names the number, for the messages.
address_from() {
  local input="$1" what="$2" host port
  input="$(printf '%s' "$input" | tr -d '[:space:]')"
  if [[ "$input" =~ ^([0-9.]+):([0-9]+)$ ]]; then
    host="${BASH_REMATCH[1]}"; port="${BASH_REMATCH[2]}"
  elif [[ "$input" =~ ^[0-9]+$ ]]; then
    host="$(phone_ip)"; port="$input"
    [ -n "$host" ] || host="127.0.0.1"
  else
    warn "Type the $what as shown on the phone, like 192.168.1.20:37123, or just the port."
    return 1
  fi
  if [ "${#port}" -eq 6 ]; then
    warn "$port has 6 digits: that is the pairing CODE, not a port. The port is the number after the colon in the address."
    return 1
  fi
  if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
    warn "$port is not a port Android uses (it is 5 digits, between 30000 and 65535)."
    return 1
  fi
  printf '%s:%s' "$host" "$port"
}

mdns() {
  # adb's own mDNS browser; may be unavailable or empty on some phones.
  timeout 6 adb mdns services 2>/dev/null | awk -v kind="$1" '$0 ~ kind { print $NF }' | grep -E '^[0-9.]+:[0-9]+$' | head -1 || true
}

# Every step from here asks for numbers shown on the phone; without a terminal
# to type them in, the questions would repeat forever.
{ : </dev/tty; } 2>/dev/null || fail "automa adb link asks for the numbers shown on the phone: run it in the Termux app."

say "1. Open Settings → Developer options → Wireless debugging and turn it on."
say "   Use split screen (or a floating window) so Termux stays visible."
say "2. Tap “Pair device with pairing code”. It shows a 6-digit code and an address."
echo

pair_addr="$(mdns _adb-tls-pairing)"
if [ -n "$pair_addr" ]; then
  say "Found the pairing address: $pair_addr"
else
  until pair_addr="$(address_from "$(ask 'Pairing address or port (under the code, like 192.168.1.20:37123): ')" "pairing address")"; do :; done
fi
until code="$(ask '6-digit pairing code: ')" && [[ "$(printf '%s' "$code" | tr -d '[:space:]')" =~ ^[0-9]{6}$ ]]; do
  warn "The pairing code is exactly 6 digits."
done
code="$(printf '%s' "$code" | tr -d '[:space:]')"

say "Pairing with $pair_addr"
if ! adb pair "$pair_addr" "$code"; then
  fail "Pairing failed. Both the code and the port change every time the dialog opens: close it, tap “Pair device with pairing code” again, and run “automa adb link” once more."
fi

echo
say "Paired. Close the pairing dialog. The Wireless debugging screen shows “IP address & Port”;"
say "that port is a DIFFERENT number from the pairing one."
connect_addr=""
for _ in 1 2 3; do
  connect_addr="$(mdns _adb-tls-connect)"
  [ -n "$connect_addr" ] && break
  sleep 1
done
if [ -n "$connect_addr" ]; then
  say "Found the connection address: $connect_addr"
else
  until connect_addr="$(address_from "$(ask 'Connection address or port (IP address & Port on the Wireless debugging screen): ')" "connection address")"; do :; done
fi

say "Connecting to $connect_addr"
out="$(adb connect "$connect_addr" 2>&1 || true)"
echo "$out"
if ! printf '%s' "$out" | grep -qi "connected to"; then
  fail "Could not connect. Check that Wireless debugging is still on and the port is the one shown under “IP address & Port” (not the pairing port), then run “automa adb link” again."
fi

echo
adb devices
say "Linked. Agents in Termux can now run: adb shell <command>"
say "Wireless debugging turns off when the phone restarts or changes Wi-Fi; run “automa adb link” again then (no new pairing needed)."
