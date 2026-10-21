"""Offline self-test: replay a realistic Workspace payload against the adapter.

    python selftest.py [adapter_url]

Defaults to http://127.0.0.1:7777. Prints the raw SSE frames and a parsed
summary so you can confirm the protocol before wiring it into the UI.
"""

from __future__ import annotations

import json
import sys

import httpx

ADAPTER = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7777").rstrip("/")

PAYLOAD = {
    "model": "MiniMax-M2.7",
    "messages": [
        {"role": "human", "content": "帮我看一下仪表盘上 AAPL 最近的走势"},
    ],
    "context": [],
    "urls": [],
    "workspace_options": {"widget-dashboard-search": True},
    "timezone": "Asia/Shanghai",
    "tools": [],
    "widgets": {
        "primary": [
            {
                "widget_id": "equity_historical",
                "name": "AAPL 日线",
                "description": "AAPL historical prices",
                "params": {"symbol": "AAPL", "interval": "1d"},
                "data": [
                    {"date": "2026-10-17", "close": 253.41, "volume": 48234100},
                    {"date": "2026-10-20", "close": 255.08, "volume": 51022900},
                ],
            }
        ],
        "secondary": [],
        "extra": [],
    },
    "workspace_state": {
        "agents": None,
        "action_history": [],
        "current_dashboard_uuid": "demo",
        "current_dashboard_info": {"name": "Harmony Glasswing"},
        "current_page_context": "dashboard",
    },
}


def main() -> int:
    print(f"adapter: {ADAPTER}")
    manifest = httpx.get(f"{ADAPTER}/agents.json", timeout=10).json()
    print("agents.json ->", json.dumps(manifest, ensure_ascii=False)[:300])

    text = ""
    events: dict[str, int] = {}

    with httpx.stream("POST", f"{ADAPTER}/v1/query", json=PAYLOAD, timeout=120) as resp:
        print("status:", resp.status_code, "| content-type:", resp.headers.get("content-type"))
        buffer = ""
        for chunk in resp.iter_text():
            buffer += chunk
            while "\n\n" in buffer:
                frame, buffer = buffer.split("\n\n", 1)
                event, data = "", ""
                for line in frame.splitlines():
                    if line.startswith("event:"):
                        event = line[6:].strip()
                    elif line.startswith("data:"):
                        data += line[5:].strip()
                if not data:
                    continue
                events[event] = events.get(event, 0) + 1
                parsed = json.loads(data)
                if event == "copilotMessageChunk":
                    text += parsed.get("delta", "")
                elif event == "copilotStatusUpdate":
                    print(f"  [{parsed.get('eventType')}] {parsed.get('message')}")

    print("events:", events)
    print("--- reply ---")
    print(text or "(empty)")
    return 0 if text else 1


if __name__ == "__main__":
    raise SystemExit(main())
