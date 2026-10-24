#!/usr/bin/env bash
# Sets up the Linux layer and installs terminal coding tools for Automa.
#
#   linux-setup.sh setup           prepare the Debian layer (phone) or report (PC)
#   linux-setup.sh install <tool>  install one tool (claude|codex|gemini|opencode|kimi)
#
# On a phone (Termux) the desktop-Linux agents (Claude Code, Codex) run inside a
# Debian userland through proot-distro; Node tools (Gemini, OpenCode, Kimi) run
# in Termux directly. On a computer everything installs natively. The script is
# safe to run again: each step skips work already done.
set -euo pipefail

DISTRO=debian
say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }

on_phone() { [ -n "${PREFIX:-}" ] && case "$PREFIX" in *com.termux*) return 0;; esac; return 1; }

# Run a command inside the Debian layer.
indeb() { proot-distro login "$DISTRO" -- bash -lc "$1"; }

ensure_wake_lock() { command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true; }

ensure_linux() {
  if ! on_phone; then
    say "This is already a computer — no Linux layer is needed."
    return 0
  fi
  ensure_wake_lock
  if ! command -v proot-distro >/dev/null 2>&1; then
    say "Installing proot-distro (the Linux layer)"
    pkg install -y proot-distro
  fi
  if ! proot-distro list --installed 2>/dev/null | grep -qw "$DISTRO"; then
    say "Installing Debian (this downloads a few hundred MB, once)"
    proot-distro install "$DISTRO"
  else
    say "Debian is already installed."
  fi
  say "Updating Debian and installing the basics (git, ripgrep, curl, Node)"
  indeb "apt-get update -y && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep xz-utils >/dev/null"
  if ! indeb "command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(\".\")[0]>=20'" 2>/dev/null | grep -q true; then
    say "Installing Node.js 22 in Debian"
    indeb "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 && apt-get install -y nodejs >/dev/null"
  fi
  say "Linux layer is ready."
}

install_node_tool() {
  # Installs a Node CLI where it will run: Debian on a phone only when asked,
  # otherwise Termux (phone) or the computer directly.
  local pkg_name="$1"; local where="$2"
  if [ "$where" = "linux" ] && on_phone; then
    indeb "npm install -g $pkg_name"
  else
    if on_phone; then command -v node >/dev/null 2>&1 || pkg install -y nodejs-lts; fi
    npm install -g "$pkg_name"
  fi
}

install_tool() {
  local tool="$1"
  case "$tool" in
    claude)
      if on_phone; then
        ensure_linux
        say "Installing Claude Code in Debian"
        indeb 'curl -fsSL https://claude.ai/install.sh | bash && grep -q ".local/bin" ~/.bashrc || echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> ~/.bashrc'
      else
        say "Installing Claude Code"
        curl -fsSL https://claude.ai/install.sh | bash
      fi
      ;;
    codex)
      if on_phone; then ensure_linux; fi
      say "Installing Codex"
      install_node_tool "@openai/codex" linux
      ;;
    gemini)
      say "Installing Gemini CLI"
      install_node_tool "@google/gemini-cli" termux
      ;;
    opencode)
      say "Installing OpenCode"
      install_node_tool "opencode-ai" termux
      ;;
    kimi)
      say "Installing Kimi CLI"
      install_node_tool "@moonshot/kimi-cli" termux
      ;;
    shell)
      say "The shell needs no install."
      ;;
    *)
      warn "Unknown tool: $tool"
      exit 2
      ;;
  esac
  say "Done. Open $tool from the Terminals screen."
}

action="${1:-}"
case "$action" in
  setup) ensure_linux ;;
  install) install_tool "${2:?usage: linux-setup.sh install <tool>}" ;;
  *) warn "usage: linux-setup.sh setup | install <tool>"; exit 2 ;;
esac
