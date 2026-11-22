#!/usr/bin/env bash
# Sets up the Linux layer and installs terminal coding tools for Automa.
#
#   linux-setup.sh setup           prepare the Debian layer (phone) or report (PC)
#   linux-setup.sh install <tool>  install one tool (claude|codex|gemini|opencode|kimi|imy)
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

# termux_pkg_install / termux_apt_archives: Termux installs that survive
# Android clearing apt's download cache mid-download ("rename failed").
# shellcheck source=../termux-pkg.sh
. "$(dirname "${BASH_SOURCE[0]}")/../termux-pkg.sh"

# Run a command inside the Debian layer. A login shell there does not always
# read ~/.bashrc, so the folders the installers put tools in are named here.
# pipefail: a download that fails in `curl … | bash` must not pass as success.
indeb() { proot-distro login "$DISTRO" -- bash -lc "set -o pipefail; export PATH=\"\$HOME/.local/bin:/usr/local/bin:\$PATH\" DEBIAN_FRONTEND=noninteractive; $1"; }
# The same, with Termux's files tree bound in at the same path (as a terminal
# has it), for a step that reads a file Automa ships, such as IMY's wheel.
indeb_files() { proot-distro login "$DISTRO" --bind "$(dirname "$PREFIX")" -- bash -lc "set -o pipefail; export PATH=\"\$HOME/.local/bin:/usr/local/bin:\$PATH\" DEBIAN_FRONTEND=noninteractive; $1"; }

ensure_wake_lock() { command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true; }

ensure_linux() {
  if ! on_phone; then
    say "This is already a computer — no Linux layer is needed."
    return 0
  fi
  ensure_wake_lock
  if ! command -v proot-distro >/dev/null 2>&1; then
    say "Installing proot-distro (the Linux layer)"
    termux_pkg_install proot-distro
  fi
  # proot-distro is a Python program. After Termux updates Python (3.13 to
  # 3.14, say) its first line still names the old interpreter and every run
  # ends with "bad interpreter: No such file or directory" (exit 126).
  # Reinstalling it writes the current one in.
  if ! proot-distro list >/dev/null 2>&1; then
    say "Repairing proot-distro (its Python interpreter moved)"
    termux_pkg_install python
    mkdir -p "$(termux_apt_archives)/partial" 2>/dev/null || true
    pkg reinstall -y proot-distro || termux_pkg_install --reinstall proot-distro || true
    if ! proot-distro list >/dev/null 2>&1; then
      interpreter="$(head -n 1 "$(command -v proot-distro)" | sed 's/^#! *//')"
      warn "proot-distro still does not start (it wants $interpreter). Run in Termux: pkg upgrade -y && pkg reinstall proot-distro"
      exit 1
    fi
  fi
  if ! proot-distro list --installed 2>/dev/null | grep -qw "$DISTRO"; then
    say "Installing Debian (this downloads a few hundred MB, once)"
    if ! proot-distro install "$DISTRO"; then
      warn "Debian did not install. Check the connection and free space (about 1 GB), then try again."
      exit 1
    fi
  else
    say "Debian is already installed."
  fi
  say "Updating Debian and installing the basics (git, ripgrep, curl, Node)"
  # apt mirrors drop connections on phones now and then: one more try.
  indeb "apt-get update -y || (sleep 5 && apt-get update -y)"
  indeb "apt-get install -y --no-install-recommends ca-certificates curl git ripgrep xz-utils procps gnupg >/dev/null"
  if ! indeb "command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(\".\")[0]>=20'" 2>/dev/null | grep -q true; then
    say "Installing Node.js 22 in Debian"
    if ! indeb "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 && apt-get install -y nodejs >/dev/null"; then
      warn "Node.js did not install in Debian (nodesource.com unreachable?). Trying Debian's own package."
      indeb "apt-get install -y --no-install-recommends nodejs npm >/dev/null"
    fi
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
    if on_phone; then command -v node >/dev/null 2>&1 || termux_pkg_install nodejs-lts; fi
    npm install -g "$pkg_name"
  fi
}

# IMY (the imagenery Python CLI) gets its own virtual environment, linked as
# ~/.local/bin/imy. The wheel Automa ships next to this script is installed when
# present, so IMY matches this release; otherwise the one on PyPI. On a phone
# IMY lives in the Debian layer, where Python installs the prebuilt wheels IMY
# needs (pydantic's included) without compiling anything.
imy_package() {
  local bundled
  bundled="$(ls "$(dirname "${BASH_SOURCE[0]}")"/imy/imagenery-*.whl 2>/dev/null | sort -V | tail -n 1 || true)"
  if [ -n "$bundled" ]; then printf '%s' "$bundled"; else printf 'imagenery'; fi
}

# The steps that put IMY into its virtual environment, the same in Debian on a
# phone and on a computer. Run by `bash -c` with the package as $1: the path of
# the wheel, or "imagenery". Ends with 3 when Python is older than IMY needs,
# 4 when no virtual environment could be made, 5 when the package did not install.
IMY_VENV_STEPS='
venv="$HOME/.local/share/imy-venv"
python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" || exit 3
if [ -x "$venv/bin/imy" ]; then verb=Updating; else verb=Installing; fi
printf "\033[1;36m==>\033[0m %s IMY\n" "$verb"
# A virtual environment an older Python left behind has no working pip: start it again.
if [ -d "$venv" ] && ! "$venv/bin/python" -m pip --version >/dev/null 2>&1; then
  python3 -m venv --clear "$venv" || exit 4
elif [ ! -d "$venv" ]; then
  python3 -m venv "$venv" || exit 4
fi
# A newer pip is welcome, not needed: an update still goes through without a connection.
"$venv/bin/python" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
"$venv/bin/python" -m pip install --quiet --upgrade "$1" || exit 5
mkdir -p "$HOME/.local/bin"
ln -sf "$venv/bin/imy" "$HOME/.local/bin/imy"
'

install_imy() {
  local package result=0
  package="$(imy_package)"
  if on_phone; then
    ensure_linux
    say "Installing Python in Debian"
    indeb "apt-get install -y --no-install-recommends python3 python3-venv python3-pip >/dev/null"
    indeb_files "bash -c $(printf '%q' "$IMY_VENV_STEPS") imy-venv $(printf '%q' "$package")" || result=$?
  else
    if ! command -v python3 >/dev/null 2>&1; then
      warn "IMY needs Python 3.11 or newer. Install Python, then try again."
      exit 1
    fi
    bash -c "$IMY_VENV_STEPS" imy-venv "$package" || result=$?
  fi
  case "$result" in
    0) ;;
    3)
      if on_phone; then
        warn "IMY needs Python 3.11 or newer, and Debian's is older. Update Debian (Terminals > Shell: proot-distro login debian -- apt full-upgrade), then try again."
      else
        warn "IMY needs Python 3.11 or newer; this computer has Python $(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')."
      fi
      exit 1
      ;;
    4)
      warn "Python could not make a virtual environment (Debian/Ubuntu: sudo apt install python3-venv)."
      exit 1
      ;;
    *)
      warn "IMY did not install. Check the connection and free space, then try again."
      exit 1
      ;;
  esac
  if on_phone; then
    if ! indeb 'imy --version'; then
      warn "IMY is installed but not answering in Debian yet. Open Terminals > Shell and run: proot-distro login debian -- imy --version"
      exit 1
    fi
    # The free models reach IMY through a small Node program Automa ships.
    if ! indeb 'command -v node >/dev/null 2>&1'; then
      warn "IMY is installed, but Debian has no Node.js, which its free models need. Open Terminals > Shell and run: proot-distro login debian -- apt-get install -y nodejs   Or give IMY a key of your own with: imy init"
    fi
  else
    "$HOME/.local/bin/imy" --version
  fi
}

install_tool() {
  local tool="$1"
  case "$tool" in
    claude)
      if on_phone; then
        ensure_linux
        say "Installing Claude Code in Debian"
        # The native installer first; the npm package when it cannot run here.
        # Kept as separate steps: an earlier one-liner let a failed installer
        # pass as success because its PATH fix-up ran as the fallback branch.
        if ! indeb 'curl -fsSL https://claude.ai/install.sh | bash'; then
          warn "The Claude Code installer did not finish; installing the npm package instead."
          indeb 'npm install -g @anthropic-ai/claude-code'
        fi
        indeb 'grep -q ".local/bin" ~/.bashrc 2>/dev/null || echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> ~/.bashrc'
        if ! indeb 'command -v claude >/dev/null 2>&1 && claude --version'; then
          warn "Claude Code is installed but not answering in Debian yet. Open Terminals > Shell and run: proot-distro login debian -- claude --version"
          exit 1
        fi
      else
        say "Installing Claude Code"
        if ! curl -fsSL https://claude.ai/install.sh | bash; then
          warn "The Claude Code installer did not finish; installing the npm package instead."
          npm install -g @anthropic-ai/claude-code
        fi
        export PATH="$HOME/.local/bin:$PATH"
        command -v claude >/dev/null 2>&1 || { warn "Claude Code did not end up on PATH. Open a new shell and run: claude --version"; exit 1; }
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
    imy)
      install_imy
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
