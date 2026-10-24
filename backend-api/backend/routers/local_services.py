"""Local service supervisor for the self-hosted Workspace stack.

Manages two sibling processes that the local Workspace UI depends on:

- OpenBB Platform API  (port 6900, D:/work/trade/OpenBB)
- Copilot adapter      (port 7777, workspace/my_tools/copilot-adapter)

plus its own status (backend-api, port 8000) and a self-restart endpoint that
relaunches the backend through a detached helper script.

Exposes a minimal control plane consumed by the Workspace sidebar status
indicators. Endpoints are intentionally unauthenticated: the backend binds
to 127.0.0.1 and the endpoints can only start/stop those two fixed local
services, so there is nothing remotely exploitable beyond what a local
user could already do.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
import urllib.request
from typing import Any

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/services", tags=["local-services"])

# --------------------------------------------------------------------------- #
# Service definitions
# --------------------------------------------------------------------------- #

OPENBB_PORT = 6900
ADAPTER_PORT = 7777
BACKEND_PORT = 8000

OPENBB_CWD = r"D:\work\trade\OpenBB"
OPENBB_CMD = [os.path.join(OPENBB_CWD, ".venv", "Scripts", "openbb-api.exe"), "--no-build"]
OPENBB_LOG = os.path.join(OPENBB_CWD, "openbb_api.log")
OPENBB_HEALTH = "http://127.0.0.1:6900/"

ADAPTER_CWD = r"D:\work\trade\workspace\my_tools\copilot-adapter"
ADAPTER_CMD = [
    r"D:\work\trade\workspace\.venv\Scripts\python.exe",
    "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "7777",
]
ADAPTER_LOG = os.path.join(ADAPTER_CWD, "_adapter.log")
ADAPTER_HEALTH = "http://127.0.0.1:7777/health"

BACKEND_CWD = r"D:\work\trade\workspace\backend-api\backend"
BACKEND_LOG = r"D:\work\my_dashboard\logs\obb_backend.log"
BACKEND_RESTART_HELPER = os.path.join(BACKEND_CWD, "_backend_restart.py")

SERVICES = {
    "openbb": {"port": OPENBB_PORT, "cmd": OPENBB_CMD, "cwd": OPENBB_CWD,
               "log": OPENBB_LOG, "health": OPENBB_HEALTH, "label": "OpenBB Platform API"},
    "adapter": {"port": ADAPTER_PORT, "cmd": ADAPTER_CMD, "cwd": ADAPTER_CWD,
                "log": ADAPTER_LOG, "health": ADAPTER_HEALTH, "label": "Copilot adapter"},
}

# CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
# 注意：不要加 DETACHED_PROCESS(0x8)——它与 CREATE_NO_WINDOW 互斥，组合后等于
# 「完全无控制台」，服务内部再用 multiprocessing/subprocess 拉起的子进程会
# 自己新建可见控制台（任务栏弹窗）。用 CREATE_NO_WINDOW 让子孙进程继承隐藏控制台。
_CREATION_FLAGS = 0x00000200 | 0x08000000
# CREATE_BREAKAWAY_FROM_JOB — let the child escape a job object so it survives
# the parent session being recycled (mirrors the service-hub agent behaviour).
_BREAKAWAY = 0x01000000

_no_proxy_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# --------------------------------------------------------------------------- #
# Process helpers (Windows, no third-party deps)
# --------------------------------------------------------------------------- #


def _child_env() -> dict:
    """Sanitise env for spawned services: drop sandbox-injected proxies and
    NODE_OPTIONS shims, keep localhost out of any proxy scope."""
    env = dict(os.environ)
    for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
                "all_proxy", "ALL_PROXY"):
        if "55718" in env.get(key, ""):
            env.pop(key, None)
    node_opts = env.get("NODE_OPTIONS") or ""
    if "workbuddy" in node_opts.lower() or "shim" in node_opts.lower():
        env.pop("NODE_OPTIONS", None)
    env["NO_PROXY"] = "127.0.0.1,localhost," + env.get("NO_PROXY", "")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return env


def listening_pids(port: int) -> set[int]:
    """PIDs currently LISTENING on the given TCP port (fresh netstat query)."""
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True, timeout=15,
                             creationflags=0x08000000).stdout.decode("mbcs", "replace")
    except Exception:  # noqa: BLE001
        return set()
    pids: set[int] = set()
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[3].upper() == "LISTENING":
            tail = parts[1].rsplit(":", 1)[-1]
            if tail.isdigit() and int(tail) == port:
                try:
                    pids.add(int(parts[4]))
                except ValueError:
                    continue
    return pids


def _kill_pid_tree(pid: int) -> None:
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], timeout=15,
                       capture_output=True, creationflags=0x08000000)
    except Exception:  # noqa: BLE001
        logger.warning("taskkill failed for pid %s", pid, exc_info=True)


def probe_health(url: str, timeout: float = 2.5) -> bool:
    """Best-effort health probe that bypasses any system proxy."""
    try:
        with _no_proxy_opener.open(urllib.request.Request(url), timeout=timeout) as resp:
            return resp.status < 400
    except Exception:  # noqa: BLE001
        return False


def _append_log(path: str, header: str) -> None:
    try:
        with open(path, "ab", buffering=0) as fh:
            fh.write(("\n===== %s %s =====\n" % (header, time.strftime("%Y-%m-%d %H:%M:%S"))).encode("utf-8"))
    except OSError:
        pass


def _spawn(cmd: list[str], cwd: str, log_path: str) -> int:
    log = open(log_path, "ab", buffering=0)
    common: dict[str, Any] = dict(cwd=cwd, stdout=log, stderr=subprocess.STDOUT, env=_child_env())
    try:
        proc = subprocess.Popen(cmd, creationflags=_CREATION_FLAGS | _BREAKAWAY, **common)
    except OSError:
        proc = subprocess.Popen(cmd, creationflags=_CREATION_FLAGS, **common)
    return proc.pid


def _wait_listening(port: int, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if listening_pids(port):
            return True
        time.sleep(0.4)
    return False


def _wait_port_free(port: int, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not listening_pids(port):
            return True
        time.sleep(0.5)
    return False


# --------------------------------------------------------------------------- #
# Operations
# --------------------------------------------------------------------------- #


def service_status(sid: str) -> dict[str, Any]:
    cfg = SERVICES[sid]
    pids = listening_pids(cfg["port"])
    running = bool(pids)
    return {
        "service": sid,
        "label": cfg["label"],
        "port": cfg["port"],
        "running": running,
        "healthy": running and probe_health(cfg["health"]),
        "pid": min(pids) if pids else None,
    }


def backend_status() -> dict[str, Any]:
    """backend-api itself — port listening is the only sensible health signal
    (docs/openapi are disabled, and a process probing itself is circular)."""
    pids = listening_pids(BACKEND_PORT)
    running = bool(pids)
    return {
        "service": "backend",
        "label": "backend-api",
        "port": BACKEND_PORT,
        "running": running,
        "healthy": running,
        "pid": min(pids) if pids else None,
    }


def restart_backend() -> str:
    """Spawn the detached helper (it waits for the port to free, then relaunches
    uvicorn), schedule this process to exit, and report back immediately."""
    if not os.path.isfile(BACKEND_RESTART_HELPER):
        raise RuntimeError(f"restart helper not found: {BACKEND_RESTART_HELPER}")
    _append_log(BACKEND_LOG, "restart backend-api (self)")
    _spawn([sys.executable, BACKEND_RESTART_HELPER], BACKEND_CWD, BACKEND_LOG)
    threading.Timer(1.2, lambda: os._exit(0)).start()
    return "restarting"


def start_service(sid: str) -> str:
    cfg = SERVICES[sid]
    if listening_pids(cfg["port"]):
        return "already running"
    if not os.path.isfile(cfg["cmd"][0]):
        raise RuntimeError(f"executable not found: {cfg['cmd'][0]}")
    _append_log(cfg["log"], f"start {cfg['label']} (via backend-api)")
    _spawn(cfg["cmd"], cfg["cwd"], cfg["log"])
    if not _wait_listening(cfg["port"], timeout=8):
        # openbb-api can take ~40s before it binds; port check is best effort
        logger.info("%s: port %s not listening yet after spawn", cfg["label"], cfg["port"])
    return "started"


def stop_service(sid: str) -> str:
    cfg = SERVICES[sid]
    pids = sorted(listening_pids(cfg["port"]))
    if not pids:
        return "not running"
    for pid in pids:
        _kill_pid_tree(pid)
    if not _wait_port_free(cfg["port"]):
        raise RuntimeError(f"port {cfg['port']} still occupied after taskkill")
    return "stopped"


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #


@router.get("/status")
async def status() -> dict[str, Any]:
    services = {sid: service_status(sid) for sid in SERVICES}
    services["backend"] = backend_status()
    return {"services": services}


@router.post("/backend/restart")
async def backend_restart() -> dict[str, Any]:
    """Self-restart: the detached helper relaunches uvicorn after this process
    exits. The response is sent before the 1.2 s delayed os._exit(0)."""
    try:
        result = restart_backend()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"service": "backend", "result": result}


@router.post("/{sid}/start")
async def start(sid: str) -> dict[str, Any]:
    if sid not in SERVICES:
        raise HTTPException(status_code=404, detail="unknown service")
    try:
        result = await _run_blocking(start_service, sid)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"service": sid, "result": result, "status": service_status(sid)}


@router.post("/{sid}/stop")
async def stop(sid: str) -> dict[str, Any]:
    if sid not in SERVICES:
        raise HTTPException(status_code=404, detail="unknown service")
    try:
        result = await _run_blocking(stop_service, sid)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"service": sid, "result": result, "status": service_status(sid)}


@router.post("/{sid}/restart")
async def restart(sid: str) -> dict[str, Any]:
    if sid not in SERVICES:
        raise HTTPException(status_code=404, detail="unknown service")
    try:
        stop_msg = await _run_blocking(stop_service, sid)
        start_msg = await _run_blocking(start_service, sid)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"service": sid, "result": f"{stop_msg}, {start_msg}", "status": service_status(sid)}


async def _run_blocking(func, *args):
    """netstat/taskkill are blocking calls — keep them off the event loop."""
    return await run_in_threadpool(func, *args)

# --------------------------------------------------------------------------- #
# Auto-start hook (called from the app lifespan)
# --------------------------------------------------------------------------- #


def _autostart_worker(delay: float = 3.0) -> None:
    time.sleep(delay)
    for sid in SERVICES:
        cfg = SERVICES[sid]
        if listening_pids(cfg["port"]):
            continue
        try:
            start_service(sid)
            logger.info("auto-started %s", cfg["label"])
        except Exception:  # noqa: BLE001
            logger.warning("auto-start failed for %s", cfg["label"], exc_info=True)


def autostart_services() -> None:
    threading.Thread(target=_autostart_worker, daemon=True, name="svc-autostart").start()
