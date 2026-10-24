#!/usr/bin/env bash
# App Inspector helper: decode, decompile and rebuild Android apps.
#
#   app-inspector.sh setup                  install apktool, apksigner and jadx
#   app-inspector.sh decode <apk> <outDir> [--no-res] [--no-src]
#                                           apktool: manifest, resources, smali
#   app-inspector.sh java <apk> <outDir>    jadx: the code as readable Java
#   app-inspector.sh rebuild <dir> <name>   rebuild + sign; copy to Downloads
#
# For apps you made or are authorized to analyze. It decodes and rebuilds only;
# it does nothing to defeat another app's licensing, DRM or anti-tamper.
set -euo pipefail

say() { printf '==> %s\n' "$*"; }
on_phone() { [ -n "${PREFIX:-}" ] && case "$PREFIX" in *com.termux*) return 0;; esac; return 1; }

# Install a Termux package when its command is missing (off-phone: explain).
need() {
  local cmd="$1" pkg="$2" hint="$3"
  command -v "$cmd" >/dev/null 2>&1 && return 0
  if on_phone; then
    say "Installing $pkg (first time only)"
    pkg install -y "$pkg" 2>&1
    command -v "$cmd" >/dev/null 2>&1 && return 0
  fi
  echo "$cmd is not installed. $hint" >&2
  exit 3
}

ensure_apktool() { need apktool apktool "Install apktool (e.g. 'brew install apktool' or your package manager) and try again."; }
ensure_java_runtime() { command -v java >/dev/null 2>&1 || need java openjdk-21 "Install a JDK (17 or newer) and try again."; }

# A folder this device's Downloads, when it can be written; empty otherwise.
downloads_dir() {
  for d in "$HOME/storage/shared/Download" "/sdcard/Download" "$HOME/Downloads"; do
    if [ -d "$d" ] && [ -w "$d" ]; then echo "$d"; return; fi
  done
}

# Next free name in a folder: app.apk, app-2.apk, app-3.apk…
unique_path() {
  local dir="$1" name="$2" stem ext n=2
  stem="${name%.apk}"; ext=".apk"
  local candidate="$dir/$name"
  while [ -e "$candidate" ]; do candidate="$dir/$stem-$n$ext"; n=$((n + 1)); done
  echo "$candidate"
}

# A local signing key with a random password, made once and kept private.
inspector_keystore() {
  local dir="$HOME/.automa" ks="$HOME/.automa/inspector-keystore.jks" pass_file="$HOME/.automa/inspector-keystore.pass"
  mkdir -p "$dir"
  if [ ! -s "$ks" ] || [ ! -s "$pass_file" ]; then
    say "Making a local signing key (first time only)" >&2
    rm -f "$ks"
    (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$pass_file")
    keytool -genkeypair -keystore "$ks" -storetype PKCS12 -alias automa \
      -storepass "$(cat "$pass_file")" -keypass "$(cat "$pass_file")" \
      -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Automa App Inspector" >/dev/null 2>&1
    chmod 600 "$ks"
  fi
  echo "$ks"
}

case "${1:-}" in
  setup)
    ensure_apktool
    ensure_java_runtime
    need apksigner apksigner "Install apksigner (Android SDK build-tools) and try again."
    need jadx jadx "Install jadx (https://github.com/skylot/jadx) to read the code as Java."
    say "App Inspector is ready."
    ;;
  decode)
    apk="${2:?usage: decode <apk> <outDir> [--no-res] [--no-src]}"; out="${3:?usage: decode <apk> <outDir>}"
    shift 3
    flags=()
    for flag in "$@"; do
      case "$flag" in
        --no-res) flags+=(-r); say "Keeping resources as they are (not decoding resources.arsc)";;
        --no-src) flags+=(-s); say "Keeping the code as it is (not disassembling classes.dex)";;
      esac
    done
    ensure_apktool
    ensure_java_runtime
    say "Decoding $(basename "$apk") with apktool"
    rm -rf "$out"
    apktool d -f ${flags[@]+"${flags[@]}"} "$apk" -o "$out"
    say "Decoded. Browse and edit the files, then rebuild when you are done."
    ;;
  java)
    apk="${2:?usage: java <apk> <outDir>}"; out="${3:?usage: java <apk> <outDir>}"
    need jadx jadx "Install jadx (https://github.com/skylot/jadx) to read the code as Java."
    say "Decompiling the code to Java with jadx (this can take a few minutes)"
    rm -rf "$out"
    # jadx exits non-zero when a few methods can't be decompiled; the rest is still useful.
    jadx --no-res --show-bad-code --deobf -j 2 -d "$out" "$apk" || say "jadx finished with some errors; most of the code is still readable."
    [ -d "$out/sources" ] || { echo "jadx produced no Java." >&2; exit 4; }
    say "Java is ready to read."
    ;;
  rebuild)
    dir="${2:?usage: rebuild <dir> <name>}"; name="${3:?usage: rebuild <dir> <name>}"
    ensure_apktool
    ensure_java_runtime
    work="$(dirname "$dir")"
    unsigned="$work/unsigned.apk"; aligned="$work/aligned.apk"
    mkdir -p "$work/out"
    out="$work/out/$name"
    rm -f "$unsigned" "$aligned" "$out"
    # apktool leaves its intermediates in <dir>/build; keep the file tree clean.
    trap 'rm -rf "$dir/build"' EXIT
    say "Rebuilding with apktool"
    apktool b "$dir" -o "$unsigned"
    # Android 11+ needs resources.arsc stored aligned; zipalign before signing.
    if command -v zipalign >/dev/null 2>&1; then
      say "Aligning"
      zipalign -p -f 4 "$unsigned" "$aligned"
    else
      cp "$unsigned" "$aligned"
    fi
    ks="$(inspector_keystore)"
    pass="$(cat "$HOME/.automa/inspector-keystore.pass")"
    say "Signing"
    if command -v apksigner >/dev/null 2>&1 || { on_phone && need apksigner apksigner "" ; }; then
      apksigner sign --ks "$ks" --ks-key-alias automa --ks-pass "pass:$pass" --key-pass "pass:$pass" --v4-signing-enabled false --out "$out" "$aligned"
    else
      # v1 (jar) signing only: fine for old phones; Android 11+ apps need apksigner.
      say "apksigner not found; signing with jarsigner (v1 only, may not install on newer Android)"
      cp "$aligned" "$out"
      jarsigner -keystore "$ks" -storepass "$pass" -keypass "$pass" "$out" automa >/dev/null
    fi
    rm -f "$unsigned" "$aligned"
    echo "[OUTPUT] $out"
    if downloads="$(downloads_dir)" && [ -n "$downloads" ]; then
      dest="$(unique_path "$downloads" "$name")"
      if cp "$out" "$dest" 2>/dev/null; then
        say "Saved to your Downloads as $(basename "$dest")."
        echo "[DOWNLOADS] $dest"
      fi
    fi
    say "Rebuilt and signed. It was signed with your own local key, so uninstall the original app before installing this one."
    ;;
  *)
    echo "usage: app-inspector.sh setup | decode <apk> <outDir> | java <apk> <outDir> | rebuild <dir> <name>" >&2
    exit 2
    ;;
esac
