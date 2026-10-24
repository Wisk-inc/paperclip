#!/usr/bin/env bash
# App Inspector helper: decode and rebuild Android apps with apktool.
#
#   app-inspector.sh setup                 install apktool + a JDK
#   app-inspector.sh decode <apk> <outDir> decode an APK into a folder
#   app-inspector.sh rebuild <dir> <name>  rebuild + sign, save to Downloads
#
# For apps you made or are authorized to analyze. It decodes and rebuilds only;
# it does nothing to defeat another app's licensing, DRM or anti-tamper.
set -euo pipefail

say() { printf '==> %s\n' "$*"; }
on_phone() { [ -n "${PREFIX:-}" ] && case "$PREFIX" in *com.termux*) return 0;; esac; return 1; }

downloads_dir() {
  for d in "$HOME/storage/shared/Download" "/sdcard/Download" "$HOME/Downloads" "$HOME"; do
    [ -d "$d" ] && { echo "$d"; return; }
  done
  echo "$HOME"
}

ensure_tools() {
  if ! command -v apktool >/dev/null 2>&1; then
    if on_phone; then say "Installing apktool and a JDK"; pkg install -y apktool openjdk-17 >/dev/null;
    else echo "apktool is not installed. Install it (e.g. 'brew install apktool' or your package manager) and try again." >&2; exit 3; fi
  fi
  command -v java >/dev/null 2>&1 || { on_phone && pkg install -y openjdk-17 >/dev/null || { echo "Java is required." >&2; exit 3; }; }
}

inspector_keystore() {
  local ks="$HOME/.automa/inspector-keystore.jks"
  mkdir -p "$HOME/.automa"
  if [ ! -s "$ks" ]; then
    say "Making a local signing key (first time)"
    keytool -genkeypair -keystore "$ks" -alias automa -storepass automa123 -keypass automa123 \
      -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Automa App Inspector" >/dev/null 2>&1
  fi
  echo "$ks"
}

case "${1:-}" in
  setup)
    ensure_tools
    say "App Inspector is ready."
    ;;
  decode)
    apk="${2:?usage: decode <apk> <outDir>}"; out="${3:?usage: decode <apk> <outDir>}"
    ensure_tools
    say "Decoding $(basename "$apk") with apktool"
    rm -rf "$out"
    apktool d -f "$apk" -o "$out"
    say "Decoded. Browse the files, then rebuild when you are done."
    ;;
  rebuild)
    dir="${2:?usage: rebuild <dir> <name>}"; name="${3:?usage: rebuild <dir> <name>}"
    ensure_tools
    tmp="$(dirname "$dir")/built.apk"
    say "Rebuilding with apktool"
    apktool b "$dir" -o "$tmp"
    ks="$(inspector_keystore)"
    say "Signing"
    if command -v apksigner >/dev/null 2>&1; then
      apksigner sign --ks "$ks" --ks-pass pass:automa123 --key-pass pass:automa123 "$tmp"
    else
      jarsigner -keystore "$ks" -storepass automa123 -keypass automa123 "$tmp" automa >/dev/null
    fi
    dest="$(downloads_dir)/$name"
    cp "$tmp" "$dest"
    say "Saved to your Downloads."
    echo "[OUTPUT] $dest"
    ;;
  *)
    echo "usage: app-inspector.sh setup | decode <apk> <outDir> | rebuild <dir> <name>" >&2
    exit 2
    ;;
esac
