"""Minimal fake OpenAI-compatible upstream, used only for offline self-tests.

It streams back a canned reply that echoes the last user message, so you can
verify the adapter plumbing end-to-end without spending a token.

    python mock_upstream.py          # listens on 127.0.0.1:7799
"""

from __future__ import annotations

import asyncio
import json

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

app = FastAPI()


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    messages = body.get("messages") or []
    last_user = ""
    for message in reversed(messages):
        if message.get("role") == "user":
            last_user = str(message.get("content") or "")
            break

    system_chars = sum(
        len(str(m.get("content") or "")) for m in messages if m.get("role") == "system"
    )
    if "LEAK" in last_user:
        # Reproduces MiniMax echoing a tool call as plain text instead of
        # emitting a real function call (see translate.parse_leaked_call).
        reply = (
            '[called get_widget_data with {"data_sources": [{"origin": "OpenBB '
            'Sandbox", "id": "tv_charting", "input_args": {"symbol": "SNDK"}}]}]'
        )
    else:
        reply = (
            f"[mock-openai] model={body.get('model')} "
            f"messages={len(messages)} system_chars={system_chars}\n\n"
            f"最后一条用户消息前 200 字：\n{last_user[:200]}"
        )

    async def gen():
        for index in range(0, len(reply), 12):
            chunk = {
                "id": "chatcmpl-mock",
                "object": "chat.completion.chunk",
                "choices": [
                    {"index": 0, "delta": {"content": reply[index : index + 12]},
                     "finish_reason": None}
                ],
            }
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            await asyncio.sleep(0.01)
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=7799, log_level="warning")
