"""E2E test for the run_trading_agents tool over the adapter's SSE stream.

    python ta_tool_test.py [question]

Verifies:
  1. status frames stream in while the pipeline runs (stage labels)
  2. the run_trading_agents tool result comes back server-side (no
     copilotFunctionCall frame should appear for it)
  3. the final answer contains a rating
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
SAMPLE = HERE / "payload_sample.json"

RATING_RE = re.compile(
    r"(Strong\s*Buy|Buy|Overweight|Hold|Neutral|Underweight|Sell|Strong\s*Sell|买入|卖出|持有|减持|超配|低配)",
    re.IGNORECASE,
)


def main() -> int:
    if not SAMPLE.exists():
        print("!! payload_sample.json 不存在：先在 Workspace 里发一条消息（DUMP_PAYLOAD=1）")
        return 2

    payload = json.loads(SAMPLE.read_text(encoding="utf-8"))
    question = (
        sys.argv[1] if len(sys.argv) > 1
        else "请对 AAPL 跑一次完整的 TradingAgents 深度分析，并给出最终评级和交易计划。"
    )
    payload["messages"] = [{"role": "human", "content": question}]
    payload.pop("api_keys", None)
    # Strip widgets so get_widget_data is not offered: the model then goes
    # straight to run_trading_agents in a single server-side turn.
    payload["widgets"] = {}
    payload["context"] = []

    status_frames: list[str] = []
    answer_parts: list[str] = []
    saw_function_call = False

    print("question:", question)
    with httpx.stream(
        "POST",
        "http://127.0.0.1:7777/v1/query",
        json=payload,
        headers={"Content-Type": "application/json"},
        timeout=1800.0,
        trust_env=False,
    ) as response:
        print("HTTP", response.status_code)
        if response.status_code >= 400:
            print(response.read().decode("utf-8", "replace")[:400])
            return 1
        event = ""
        for line in response.iter_lines():
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data = line[5:].strip()
                try:
                    body = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if event == "copilotStatusUpdate":
                    text = str(body.get("message") or "")
                    status_frames.append(text)
                    print(f"  [status] {text[:120]}")
                elif event == "copilotMessageChunk":
                    answer_parts.append(body.get("delta", ""))
                elif event == "copilotFunctionCall":
                    saw_function_call = True
                    print("  [function-call]", data[:200])

    answer = "".join(answer_parts)
    print("\n---- final answer (first 800 chars) ----")
    print(answer[:800])

    ok = True
    if not status_frames:
        print("FAIL: no status frames streamed during the TA run")
        ok = False
    ta_stages = [s for s in status_frames if ("分析" in s or "辩论" in s or "决策" in s or "交易员" in s)]
    print(f"\nTA-related status frames: {len(ta_stages)}")
    for s in ta_stages[:12]:
        print("  -", s[:100])
    if not ta_stages:
        print("FAIL: no TA stage labels observed — tool probably never ran")
        ok = False
    if saw_function_call:
        print("FAIL: run_trading_agents leaked as a frontend copilotFunctionCall")
        ok = False
    if not RATING_RE.search(answer):
        print("FAIL: final answer lacks a rating")
        ok = False
    print("\nRESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
