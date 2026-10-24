"""Detached restart helper for backend-api (port 8000).

Spawned by the ``POST /services/backend/restart`` endpoint right before the
running backend exits. Because the helper runs fully detached (breakaway from
the job object), it survives the parent process dying.

Sequence: wait for port 8000 to be released (up to 20 s) → relaunch uvicorn.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time

PORT = 8000
CWD = os.path.dirname(os.path.abspath(__file__))
LOG = r"D:\work\my_dashboard\logs\obb_backend.log"
CMD = [
    r"D:\work\trade\workspace\.venv\Scripts\python.exe",
    "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8000",
]


def port_busy() -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", PORT)) == 0


def main() -> None:
    deadline = time.time() + 20
    while time.time() < deadline and port_busy():
        time.sleep(0.4)
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    fh = open(LOG, "ab", buffering=0)
    fh.write(("\n===== restart %s =====\n" % time.strftime("%Y-%m-%d %H:%M:%S")).encode())
    env = dict(os.environ)
    env["NO_PROXY"] = "127.0.0.1,localhost," + env.get("NO_PROXY", "")
    # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | BREAKAWAY
    flags = 0x00000008 | 0x00000200 | 0x08000000 | 0x01000000
    try:
        subprocess.Popen(CMD, cwd=CWD, stdout=fh, stderr=subprocess.STDOUT,
                         env=env, creationflags=flags)
    except OSError:
        subprocess.Popen(CMD, cwd=CWD, stdout=fh, stderr=subprocess.STDOUT,
                         env=env, creationflags=flags & ~0x01000000)


if __name__ == "__main__":
    sys.exit(main())
