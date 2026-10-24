#!/usr/bin/env python3
"""A tiny PTY relay so a real terminal program (Claude Code, Codex, a shell)
can run under Automa and stream to a browser.

    pty-relay.py <cols> <rows> -- <command> [args...]

- Keystrokes arrive on stdin (raw bytes) and go to the program's PTY.
- The program's output is written to stdout (raw bytes).
- Resize messages arrive on fd 3 as JSON lines: {"cols":120,"rows":40}\n
- The relay exits with the program's exit code (128+signal when it was killed).

No third-party packages: only the standard library, so it runs the same in
Termux and in a proot Debian container.
"""
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import fcntl


def set_winsize(fd, cols, rows):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def main():
    argv = sys.argv[1:]
    if len(argv) < 4 or argv[2] != "--":
        sys.stderr.write("usage: pty-relay.py <cols> <rows> -- <command> [args...]\n")
        return 2
    try:
        cols = max(1, min(1000, int(argv[0])))
        rows = max(1, min(1000, int(argv[1])))
    except ValueError:
        cols, rows = 80, 24
    command = argv[3:]

    pid, master = pty.fork()
    if pid == 0:
        # Child: become the program. A sane TERM so TUIs draw in colour.
        os.environ.setdefault("TERM", "xterm-256color")
        try:
            os.execvp(command[0], command)
        except OSError as error:
            sys.stderr.write(f"could not start {command[0]}: {error}\n")
            os._exit(127)
        return 127

    set_winsize(master, cols, rows)
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    # The resize side channel; absent when the parent did not open fd 3.
    try:
        os.fstat(3)
        control_fd = 3
    except OSError:
        control_fd = -1
    control_buf = b""

    for fd in (stdin_fd, master) + ((control_fd,) if control_fd >= 0 else ()):
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    while True:
        watch = [master, stdin_fd] + ([control_fd] if control_fd >= 0 else [])
        try:
            readable, _, _ = select.select(watch, [], [])
        except (InterruptedError, OSError):
            continue
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if not data:
                break
            try:
                os.write(stdout_fd, data)
            except OSError:
                break
        if stdin_fd in readable:
            try:
                data = os.read(stdin_fd, 65536)
            except OSError:
                data = b""
            if data:
                try:
                    os.write(master, data)
                except OSError:
                    pass
            # EOF on stdin is not a reason to kill the program; it keeps running.
        if control_fd >= 0 and control_fd in readable:
            try:
                chunk = os.read(control_fd, 4096)
            except OSError:
                chunk = b""
            if chunk:
                control_buf += chunk
                while b"\n" in control_buf:
                    line, control_buf = control_buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        message = json.loads(line)
                        set_winsize(master, int(message["cols"]), int(message["rows"]))
                    except (ValueError, KeyError, TypeError):
                        pass

    try:
        _, status = os.waitpid(pid, 0)
    except OSError:
        return 0
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
