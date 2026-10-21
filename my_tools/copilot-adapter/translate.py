"""Translate an OpenBB Workspace copilot payload into OpenAI chat messages.

The Workspace frontend POSTs a rich payload (messages + dashboard widgets +
attached context + MCP tool definitions). This module flattens the useful part
into a system prompt plus a plain `[{role, content}]` history that any
OpenAI-compatible endpoint understands.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

ARTIFACT_RE = re.compile(r"<artifact className=\"[^\"]*\"\s*/>")
CITATION_RE = re.compile(r"<citation className=\"[^\"]*\"\s*/>")

SYSTEM_PREAMBLE = """\
You are the AI assistant embedded in OpenBB Workspace, a professional \
financial-data terminal used by analysts and traders.

You can see the data currently loaded in the user's dashboard widgets: it is \
provided below. Treat that data as the ground truth for questions about \
"this chart", "my dashboard", "these numbers" and similar.

Rules:
- Reply in the language the user writes in (Chinese in, Chinese out).
- When you quote a number that came from a widget, name the widget it came \
from. Never invent prices, volumes or dates that are not in the provided data.
- If the needed data is not present, say so plainly and describe which widget \
or parameter the user should add, instead of guessing.
- You cannot click buttons, execute tools or modify the dashboard. You can \
only read the data given below and answer.
- Keep answers compact and decision-oriented: numbers first, then the reasoning.
- Use markdown tables for multi-instrument comparisons."""


def _json_block(obj: Any, limit: int) -> str:
    try:
        text = json.dumps(obj, ensure_ascii=False, default=str)
    except Exception:  # pragma: no cover - defensive
        text = str(obj)
    if len(text) <= limit:
        return text
    return text[:limit] + f" …[truncated {len(text) - limit} chars]"


def _strip_markers(text: str) -> str:
    return CITATION_RE.sub("", ARTIFACT_RE.sub("", text)).strip()


def _as_function_call(content: str) -> str | None:
    """Hidden function-call AI messages look like {"function": ..., ...}."""
    stripped = content.strip()
    if not (stripped.startswith("{") and stripped.endswith("}")):
        return None
    try:
        parsed = json.loads(stripped)
    except Exception:
        return None
    if not isinstance(parsed, dict) or "function" not in parsed:
        return None
    name = parsed.get("function")
    args = parsed.get("input_arguments")
    return f"[called {name} with {_json_block(args, 600)}]" if args else f"[called {name}]"


def _render_widget(widget: dict[str, Any], budget: int) -> str:
    name = widget.get("name") or widget.get("widget_id") or "Widget"
    widget_id = widget.get("widget_id") or ""
    description = (widget.get("description") or "").strip()

    header = f"### {name}"
    if widget_id and widget_id != name:
        header += f" (`{widget_id}`)"

    lines = [header]
    if description:
        lines.append(description[:400])

    params = widget.get("params")
    if isinstance(params, dict) and params:
        lines.append("parameters: " + _json_block(params, 600))
    elif isinstance(params, list) and params:
        lines.append("parameters: " + _json_block(params, 600))

    data = None
    for key in ("data", "widget_data", "results", "result"):
        if widget.get(key) not in (None, "", [], {}):
            data = widget[key]
            break
    if data is not None:
        lines.append("data: " + _json_block(data, budget))
    else:
        lines.append("data: (not loaded)")

    return "\n".join(lines)


def _render_context_item(item: dict[str, Any], budget: int) -> str:
    name = item.get("name") or item.get("uuid") or "Attachment"
    description = (item.get("description") or "").strip()
    chunks: list[str] = [f"### {name}"]
    if description:
        chunks.append(description[:400])

    payload = item.get("data") or {}
    items = payload.get("items") if isinstance(payload, dict) else None
    if isinstance(items, list):
        remaining = budget
        for sub in items[:5]:
            if remaining <= 0:
                break
            content = sub.get("content") if isinstance(sub, dict) else sub
            fmt = (sub.get("data_format") or {}) if isinstance(sub, dict) else {}
            parse_as = fmt.get("parse_as") or fmt.get("data_type") or "text"
            text = content if isinstance(content, str) else _json_block(content, remaining)
            text = text[:remaining]
            remaining -= len(text)
            chunks.append(f"[{parse_as}] {text}")
    else:
        chunks.append(_json_block(item.get("data"), budget))

    return "\n".join(chunks)


def _safe_float(value: Any, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number


def build_system_prompt(payload: dict[str, Any], max_chars: int, widget_max_chars: int) -> str:
    parts: list[str] = [SYSTEM_PREAMBLE]

    tz = payload.get("timezone") or "unknown"
    now = datetime.now(timezone.utc).astimezone()
    parts.append(
        f"Current date/time: {now.strftime('%Y-%m-%d %H:%M:%S %Z')} "
        f"(user timezone: {tz})."
    )

    dashboard_info = (payload.get("workspace_state") or {}).get("current_dashboard_info")
    if isinstance(dashboard_info, dict):
        dash_name = dashboard_info.get("name") or dashboard_info.get("title")
        if dash_name:
            parts.append(f"Active dashboard: {dash_name}")

    budget = max_chars - len("\n\n".join(parts))

    widgets = payload.get("widgets") or {}
    primary = widgets.get("primary") or []
    secondary = widgets.get("secondary") or []

    def add_section(title: str, entries: list[dict[str, Any]], note: str, cap: int) -> None:
        nonlocal budget
        if not entries or budget <= 0:
            return
        rendered: list[str] = []
        for widget in entries:
            if not isinstance(widget, dict):
                continue
            if budget <= 200:
                rendered.append("…(remaining widgets omitted for length)")
                break
            block = _render_widget(widget, min(cap, budget))
            rendered.append(block)
            budget -= len(block)
        if rendered:
            parts.append(f"## {title}\n{note}\n\n" + "\n\n".join(rendered))

    add_section(
        "Widgets the user explicitly attached",
        primary,
        "These were pinned to the conversation on purpose — prioritise them.",
        widget_max_chars,
    )
    add_section(
        "Other widgets on the active dashboard",
        secondary,
        "Available for context; only use when relevant.",
        min(widget_max_chars, 4000),
    )

    extra = widgets.get("extra") or []
    if extra and budget > 500:
        add_section(
            "Widgets available in the workspace (not on the dashboard)",
            extra[:20],
            "These are not loaded; they exist only as a catalogue.",
            min(widget_max_chars, 1500),
        )

    context_items = payload.get("context") or []
    if context_items and budget > 200:
        rendered = []
        for item in context_items:
            if not isinstance(item, dict) or budget <= 200:
                break
            block = _render_context_item(item, min(widget_max_chars, budget))
            rendered.append(block)
            budget -= len(block)
        if rendered:
            parts.append("## Attached context\n\n" + "\n\n".join(rendered))

    return "\n\n".join(parts)


def build_messages(
    payload: dict[str, Any],
    max_chars: int,
    widget_max_chars: int,
) -> list[dict[str, str]]:
    """Return an OpenAI-style message list (system prompt first)."""
    messages: list[dict[str, str]] = [
        {"role": "system", "content": build_system_prompt(payload, max_chars, widget_max_chars)}
    ]

    for raw in payload.get("messages") or []:
        if not isinstance(raw, dict):
            continue
        role = raw.get("role")
        if role == "system":
            # Workspace system messages are UI status bubbles, not model input.
            continue

        content = raw.get("content")
        if not isinstance(content, str):
            content = _json_block(content, 4000)
        content = _strip_markers(content)

        if role == "tool":
            function = raw.get("function") or "tool"
            block = _json_block(raw.get("data"), 4000)
            messages.append({"role": "user", "content": f"[tool result: {function}]\n{block}"})
            continue

        if not content:
            continue

        if role == "ai":
            described = _as_function_call(content)
            messages.append({"role": "assistant", "content": described or content})
        else:
            messages.append({"role": "user", "content": content})

    merged = _merge_consecutive(messages)

    if not any(m["role"] == "user" for m in merged[1:]):
        merged.append({"role": "user", "content": "Hello"})

    return merged


def _merge_consecutive(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    """Some providers reject repeated roles; fold them into one turn."""
    merged: list[dict[str, str]] = []
    for message in messages:
        if merged and merged[-1]["role"] == message["role"]:
            merged[-1]["content"] = f"{merged[-1]['content']}\n\n{message['content']}"
        else:
            merged.append(dict(message))
    return merged


def resolve_sampling(payload: dict[str, Any], default_temperature: float) -> float:
    return _safe_float(payload.get("temperature"), default_temperature)
