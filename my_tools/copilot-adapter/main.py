"""OpenAI-compatible Copilot adapter for OpenBB Workspace.

Exposes the two endpoints Workspace needs in order to register an external
copilot, and bridges them to any OpenAI-compatible chat-completions API:

    GET  /agents.json   -> agent discovery manifest
    POST /v1/query      -> Server-Sent-Events chat stream

Extra helpers: GET /health, GET /v1/models, POST /v1/generate/chat/title.

Run:  python -m uvicorn main:app --host 127.0.0.1 --port 7777
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, AsyncIterator

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

from settings import settings
from translate import (
    build_messages,
    normalize_get_widget_args,
    tool_call_count,
    widget_sources,
)
from reasoning import ReasoningSplitter

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("copilot-adapter")

app = FastAPI(title="OpenAI-Compatible Copilot Adapter", version="1.0.0")

# Workspace runs on another origin (e.g. http://127.0.0.1:3000), so the browser
# needs CORS on both the manifest and the SSE endpoint.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Trace-Id"],
)


# --------------------------------------------------------------------------- #
# SSE helpers
# --------------------------------------------------------------------------- #
def _sse(event: str, data: dict[str, Any]) -> str:
    """One Workspace-compatible SSE frame (blank line terminated)."""
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


def _status(message: str, event_type: str = "INFO") -> str:
    return _sse("copilotStatusUpdate", {"eventType": event_type, "message": message})


def _done() -> str:
    # Frontend skips frames with an empty data buffer, so `{}` is required.
    return _sse("done", {})


# --------------------------------------------------------------------------- #
# Upstream request resolution (env defaults, per-request header overrides)
# --------------------------------------------------------------------------- #
def _resolve_upstream(request: Request) -> tuple[str, str, str]:
    base_url = request.headers.get("x-upstream-base-url") or settings.base_url
    api_key = request.headers.get("x-upstream-key") or settings.api_key
    model = request.headers.get("x-upstream-model") or settings.model
    return settings.upstream_url(base_url), api_key, model


def _http_client() -> httpx.AsyncClient:
    """Never inherit ambient proxy env vars unless explicitly configured.

    Workspace sessions can inject HTTP(S)_PROXY for unrelated traffic; using it
    here would tunnel API calls through the wrong proxy. Set UPSTREAM_PROXY in
    .env when the endpoint genuinely needs one.
    """
    kwargs: dict[str, Any] = {"timeout": httpx.Timeout(settings.upstream_timeout)}
    if settings.upstream_proxy:
        kwargs["proxy"] = settings.upstream_proxy
        kwargs["trust_env"] = False
    else:
        kwargs["trust_env"] = False
    return httpx.AsyncClient(**kwargs)


# --------------------------------------------------------------------------- #
# Widget data tool (mirrors the function Workspace itself understands)
# --------------------------------------------------------------------------- #
# Workspace never sends widget VALUES to the agent: it sends metadata only and
# expects the agent to ask for the data with this function call. The frontend
# then resolves origin/id against the live dashboard, fetches the rows and POSTs
# them back to this same /v1/query endpoint as a `tool` message.
GET_WIDGET_DATA_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "get_widget_data",
        "description": (
            "Fetch the current data of one or more dashboard widgets. Use this "
            "before answering any question about widget values, prices, tables "
            "or charts. Pass the exact origin and id shown in the widget "
            "catalogue, plus widget_uuid when available."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "data_sources": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "widget_uuid": {
                                "type": "string",
                                "description": "Widget instance uuid on the dashboard.",
                            },
                            "origin": {
                                "type": "string",
                                "description": "Widget origin, e.g. 'OpenBB Platform (local 6900)'.",
                            },
                            "id": {
                                "type": "string",
                                "description": "Widget id, e.g. 'equity_price_historical'.",
                            },
                            "input_args": {
                                "type": "object",
                                "description": "Widget parameters (symbol, interval, ...).",
                            },
                        },
                        "required": ["origin", "id"],
                    },
                }
            },
            "required": ["data_sources"],
        },
    },
}


def _humanize_upstream_error(status: int, body: str) -> str:
    snippet = (body or "").strip()
    if len(snippet) > 600:
        snippet = snippet[:600] + "…"
    hints = {
        401: "API Key 无效或未授权，请检查 .env 里的 OPENAI_API_KEY",
        403: "上游拒绝访问（403），可能是账号权限或模型未开通",
        404: "上游端点不存在（404），请检查 OPENAI_BASE_URL 是否为 .../v1",
        429: "上游限流或额度不足（429），请稍后重试或检查账户余额",
    }
    hint = hints.get(status, "上游返回错误")
    return f"{hint}。HTTP {status}: {snippet}"


# --------------------------------------------------------------------------- #
# Discovery
# --------------------------------------------------------------------------- #
def _manifest() -> dict[str, Any]:
    features: dict[str, Any] = {
        # Streaming chat over SSE.
        "streaming": True,
        # Lets the user push dashboard widgets into the conversation context.
        "widget-dashboard-select": True,
        "widget-dashboard-search": True,
    }
    if settings.feature_global_search:
        features["widget-global-search"] = True
    if settings.feature_generative_ui:
        features["generative-ui"] = True
    if settings.feature_mcp_tools:
        features["mcp-tools"] = True

    return {
        settings.agent_id: {
            "id": settings.agent_id,
            "name": settings.agent_name,
            "description": settings.agent_description,
            # Relative path: Workspace resolves it against the URL the user
            # typed, so LAN access works without hard-coding a host.
            "endpoints": {"query": "v1/query"},
            "features": features,
            "models": [{"id": m, "name": m} for m in settings.model_list()],
        }
    }


@app.get("/agents.json")
async def agents_json() -> JSONResponse:
    return JSONResponse(_manifest())


@app.get("/copilots.json")
async def copilots_json() -> JSONResponse:
    """Legacy alias kept for older Workspace builds."""
    return JSONResponse(_manifest())


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "agent": settings.agent_id,
            "upstream": settings.upstream_url(),
            "model": settings.model,
            "models": settings.model_list(),
            "api_key_configured": bool(settings.api_key),
            "proxy": settings.upstream_proxy or None,
        }
    )


@app.get("/v1/models")
async def list_models() -> JSONResponse:
    return JSONResponse(
        {
            "object": "list",
            "data": [
                {"id": m, "object": "model", "owned_by": "upstream"}
                for m in settings.model_list()
            ],
        }
    )


# --------------------------------------------------------------------------- #
# Chat stream
# --------------------------------------------------------------------------- #
@app.post("/v1/query")
async def query(request: Request) -> Response:
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"detail": "invalid JSON body"}, status_code=400)

    # Debug aid: DUMP_PAYLOAD=1 writes the raw Workspace payload (keys scrubbed)
    # to payload_sample.json next to this file, for protocol inspection.
    if os.getenv("DUMP_PAYLOAD") == "1":
        try:
            safe = json.loads(json.dumps(payload, default=str))
            safe.pop("api_keys", None)
            dump_path = os.path.join(os.path.dirname(__file__), "payload_sample.json")
            with open(dump_path, "w", encoding="utf-8") as handle:
                json.dump(safe, handle, ensure_ascii=False, indent=2)
        except Exception:
            log.exception("payload dump failed")

    url, api_key, default_model = _resolve_upstream(request)
    model = (
        request.headers.get("x-upstream-model")
        or (payload.get("model") or "").strip()
        or default_model
    )
    messages = build_messages(
        payload,
        max_chars=settings.context_max_chars,
        widget_max_chars=settings.widget_max_chars,
    )

    trace_id = request.headers.get("x-trace-id", "")

    sources = widget_sources(payload)
    tool_rounds = tool_call_count(payload)

    widgets = payload.get("widgets") or {}
    log.info(
        "query: model=%s messages=%d chars=%d trace=%s widgets(p/s/e)=%d/%d/%d ctx=%d tools=%d sources=%d rounds=%d",
        model,
        len(messages),
        sum(len(m["content"]) for m in messages),
        trace_id or "-",
        len(widgets.get("primary") or []),
        len(widgets.get("secondary") or []),
        len(widgets.get("extra") or []),
        len(payload.get("context") or []),
        len(payload.get("tools") or []),
        len(sources),
        tool_rounds,
    )
    log.debug("payload keys: %s", sorted(payload.keys()))

    async def stream() -> AsyncIterator[str]:
        if not api_key:
            log.error("missing API key")
            yield _status(
                "适配层未配置 API Key：请在 my_tools/copilot-adapter/.env 中填写 "
                "OPENAI_API_KEY 后重启服务，或在 Add Copilot 的 Headers 里加 "
                "X-Upstream-Key。",
                "ERROR",
            )
            yield _done()
            return

        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
            "temperature": settings.temperature,
        }
        if settings.max_tokens > 0:
            body["max_tokens"] = settings.max_tokens
        if 0 < settings.top_p < 1:
            body["top_p"] = settings.top_p

        # Offer the widget-data tool whenever the user has widgets in context and
        # we are not stuck in a tool-call loop.
        use_tools = bool(sources) and tool_rounds < settings.max_tool_rounds
        if use_tools:
            body["tools"] = [GET_WIDGET_DATA_TOOL]
            body["tool_choice"] = "auto"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }

        try:
            async with _http_client() as client:
                async with client.stream("POST", url, json=body, headers=headers) as resp:
                    if resp.status_code >= 400:
                        raw = (await resp.aread()).decode("utf-8", "replace")
                        log.error("upstream %s: %s", resp.status_code, raw[:400])
                        yield _status(
                            _humanize_upstream_error(resp.status_code, raw), "ERROR"
                        )
                        yield _done()
                        return

                    # Reasoning models (MiniMax M-series) inline their chain of
                    # thought as <think>…</think> in the content stream. Peel it
                    # out so the chat shows a collapsible reasoning section
                    # instead of raw tags.
                    splitter = (
                        ReasoningSplitter()
                        if settings.reasoning_mode != "inline"
                        else None
                    )
                    reason_buf = ""
                    # OpenAI-style streamed tool calls arrive as fragments that
                    # must be concatenated by index before we can parse the JSON.
                    pending_calls: dict[int, dict[str, str]] = {}

                    def take_reasoning(force: bool = False) -> list[str]:
                        nonlocal reason_buf
                        if settings.reasoning_mode == "hide":
                            reason_buf = ""
                            return []
                        if not reason_buf:
                            return []
                        if (
                            not force
                            and len(reason_buf) < settings.reasoning_chunk_chars
                            and "\n" not in reason_buf
                        ):
                            return []
                        text = reason_buf.strip()
                        reason_buf = ""
                        return [_status(text)] if text else []

                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        chunk = line[5:].strip()
                        if not chunk:
                            continue
                        if chunk == "[DONE]":
                            break
                        try:
                            obj = json.loads(chunk)
                        except json.JSONDecodeError:
                            continue  # keep-alive or vendor-specific frame

                        choices = obj.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}

                        for call in delta.get("tool_calls") or []:
                            index = int(call.get("index", 0) or 0)
                            slot = pending_calls.setdefault(
                                index, {"name": "", "arguments": "", "id": ""}
                            )
                            if call.get("id"):
                                slot["id"] = call["id"]
                            function = call.get("function") or {}
                            if function.get("name"):
                                slot["name"] = function["name"]
                            if function.get("arguments"):
                                slot["arguments"] += function["arguments"]

                        # Some vendors (MiniMax with reasoning_split, DeepSeek)
                        # send the chain of thought in a separate field.
                        explicit_reasoning = delta.get("reasoning_content") or delta.get(
                            "reasoning"
                        )
                        if explicit_reasoning:
                            reason_buf += explicit_reasoning
                            for frame in take_reasoning():
                                yield frame

                        text = delta.get("content")
                        if text:
                            if splitter is None:
                                yield _sse("copilotMessageChunk", {"delta": text})
                            else:
                                for kind, piece in splitter.feed(text):
                                    if kind == "answer":
                                        # Answer started: push out any reasoning
                                        # still buffered so the transcript keeps
                                        # its ordering (thinking, then answer).
                                        for frame in take_reasoning(force=True):
                                            yield frame
                                        yield _sse(
                                            "copilotMessageChunk", {"delta": piece}
                                        )
                                    else:
                                        reason_buf += piece
                                        for frame in take_reasoning():
                                            yield frame

                        finish = choices[0].get("finish_reason")
                        if finish == "length":
                            yield _status(
                                "输出达到 max_tokens 上限被截断，可在 .env 调大 "
                                "OPENAI_MAX_TOKENS。",
                                "WARNING",
                            )

                    # Flush anything the splitter held back (partial tag tail or
                    # an unclosed reasoning block).
                    if splitter is not None:
                        tail = splitter.flush()
                        answer_tail = "".join(p for k, p in tail if k == "answer")
                        reason_buf += "".join(p for k, p in tail if k == "think")
                    else:
                        answer_tail = ""
                    for frame in take_reasoning(force=True):
                        yield frame
                    if answer_tail:
                        yield _sse("copilotMessageChunk", {"delta": answer_tail})

                    # A tool call ends this turn. Workspace executes it against
                    # the live dashboard and POSTs the data back to /v1/query.
                    if pending_calls:
                        call = pending_calls[min(pending_calls)]
                        name = call["name"] or "get_widget_data"
                        try:
                            arguments = (
                                json.loads(call["arguments"]) if call["arguments"] else {}
                            )
                        except json.JSONDecodeError:
                            arguments = {}
                            yield _status(
                                "模型返回的工具参数不是合法 JSON，本次调用已跳过。",
                                "WARNING",
                            )
                        if name != "get_widget_data":
                            log.warning("unsupported tool requested: %s", name)
                            yield _status(f"模型请求了不支持的工具 {name}，已忽略。", "WARNING")
                        elif arguments:
                            arguments = normalize_get_widget_args(arguments, sources)
                            log.info(
                                "function call: %s args=%s",
                                name,
                                json.dumps(arguments, ensure_ascii=False)[:400],
                            )
                            yield _sse(
                                "copilotFunctionCall",
                                {
                                    "function": name,
                                    "input_arguments": arguments,
                                    # Workspace drops widget tool results when
                                    # extra_state is empty (it assumes the
                                    # built-in copilot reads data from its own
                                    # store). A non-empty marker keeps the data
                                    # in the follow-up payload.
                                    "extra_state": {
                                        "adapter": "openai-compatible-copilot",
                                        "requested_widgets": len(
                                            arguments.get("data_sources") or []
                                        ),
                                    },
                                },
                            )
                        yield _done()
                        return

        except httpx.TimeoutException:
            log.error("upstream timeout after %ss", settings.upstream_timeout)
            yield _status(
                f"上游响应超时（{int(settings.upstream_timeout)}s）。若模型较慢，"
                "可在 .env 增大 UPSTREAM_TIMEOUT。",
                "ERROR",
            )
        except httpx.HTTPError as exc:
            log.exception("upstream transport error")
            yield _status(
                f"无法连接上游 {url}：{type(exc).__name__}: {exc}。"
                "国内网络访问 api.minimax.io 需在 .env 设置 "
                "UPSTREAM_PROXY=http://127.0.0.1:10808（api.minimaxi.com 一般直连即可）。",
                "ERROR",
            )
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("unexpected error")
            yield _status(f"适配层内部错误：{type(exc).__name__}: {exc}", "ERROR")

        yield _done()

    response_headers = {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    if trace_id:
        response_headers["X-Trace-Id"] = trace_id

    return StreamingResponse(
        stream(),
        media_type="text/event-stream; charset=utf-8",
        headers=response_headers,
    )


# --------------------------------------------------------------------------- #
# Chat title generation (used if Workspace is pointed at this host for it)
# --------------------------------------------------------------------------- #
@app.post("/v1/generate/chat/title")
async def generate_title(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"title": "New Chat"})

    messages = payload.get("messages") or []
    opening = ""
    for message in messages:
        if message.get("role") == "human" and message.get("content"):
            opening = str(message["content"])[:400]
            break

    title = " ".join(opening.split())[:48] or "New Chat"
    return JSONResponse({"title": title, "chat_title": title})


if __name__ == "__main__":
    import uvicorn

    log.info("starting adapter on http://%s:%s", settings.host, settings.port)
    log.info("upstream=%s model=%s key=%s", settings.upstream_url(), settings.model,
             "set" if settings.api_key else "MISSING")
    uvicorn.run("main:app", host=settings.host, port=settings.port, log_level="info")
