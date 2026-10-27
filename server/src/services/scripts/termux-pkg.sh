#!/usr/bin/env bash
# Installs Termux packages without losing a finished download.
#
#   termux-pkg.sh <package>...    install the packages (or source this file and
#                                 call termux_pkg_install <package>...)
#
# apt downloads each package into archives/partial and then renames it into
# archives. Termux keeps that cache in Android's own app cache folder
# (/data/data/com.termux/cache, beside files/ rather than inside it), and
# Android may clear that folder whenever it likes, even during a download:
# the install then ends with "rename failed, No such file or directory" after
# the whole package arrived. So this makes the folders apt really uses, and
# when the install still fails it installs again with a download folder inside
# Termux's own files, which Android leaves alone.

termux_prefix() { printf '%s\n' "${PREFIX:-/data/data/com.termux/files/usr}"; }

# The folder apt downloads packages into, as apt itself reports it.
termux_apt_archives() {
  local dir=""
  if command -v apt-config >/dev/null 2>&1; then
    eval "$(apt-config shell dir Dir::Cache::archives/d 2>/dev/null)" 2>/dev/null || dir=""
  fi
  # Termux's default: /data/data/com.termux/cache/apt/archives (two levels above usr).
  [ -n "$dir" ] || dir="$(termux_prefix)/../../cache/apt/archives"
  printf '%s\n' "${dir%/}"
}

termux_pkg_install() {
  [ "$#" -gt 0 ] || return 0
  local archives cache private attempt
  archives="$(termux_apt_archives)"
  mkdir -p "$archives/partial" 2>/dev/null || true
  if pkg install -y "$@"; then return 0; fi

  printf '==> %s\n' "The install was interrupted; trying again with Automa's own download folder" >&2
  cache="$(termux_prefix)/var/cache/automa-apt"
  private="$cache/archives"
  mkdir -p "$private/partial"
  apt-get update || true
  for attempt in 1 2; do
    if apt-get -o Dir::Cache::archives="$private/" -o Acquire::Retries=3 install -y --fix-missing "$@"; then
      # The downloaded packages are installed now: give the phone its space back.
      rm -rf "$cache"
      return 0
    fi
    sleep "${AUTOMA_PKG_RETRY_WAIT:-3}"
  done
  rm -rf "$cache"
  return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  termux_pkg_install "$@"
fi
