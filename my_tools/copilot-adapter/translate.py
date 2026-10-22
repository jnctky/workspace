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

You are wired into the user's live dashboard. Workspace gives you each \
widget's metadata (name, origin, id, parameters) but NOT its values: to read \
the numbers you MUST call the `get_widget_data` tool with the widget's exact \
origin / id / widget_uuid.

Rules:
- Before answering anything about "this chart", "my dashboard", "the table on \
the left" or any concrete price/number, call `get_widget_data` first.
- Never say you cannot see widget data without having called the tool in this \
turn; call it instead.
- When asked what a widget currently SHOWS, do not invent or replace its \
parameters: use the exact data_args listed in the widget's metadata below. \
Only change a parameter when the user explicitly asks for a different one, \
and say so in the answer.
- When you quote a number that came from a widget, name the widget it came \
from. Never invent prices, volumes or dates that are not in the returned data.
- If a widget needed for the question is not in the catalogue below, say which \
widget the user should add to the dashboard (or attach to the chat), instead \
of guessing.
- Widget ids are exact strings. Widgets served by the local OpenBB Platform \
backend append provider + `_obb` to the endpoint path: \
`equity_price_quote_nasdaq_obb`, `equity_price_historical_nasdaq_obb`, \
`equity_price_historical_cboe_obb`. A bare endpoint name such as \
`equity_price_historical` is NOT a valid id - sending it returns another \
widget's cached rows. If the widget you need is not in the catalogue, send the \
backend-registry id (origin + id, no widget_uuid) or ask the user to add it.
- A `widget_uuid` belongs to exactly one widget instance: only send it together \
with the id listed next to that uuid in the catalogue. Never reuse a uuid for a \
different id.
- Chart widgets such as `tv_charting` only expose the symbol currently selected \
inside them: sending a different `symbol` in `input_args` does not refetch, it \
still returns that chart's own rows. When the user asks for another symbol's \
candles or a specific date range, call `equity_price_historical_nasdaq_obb` \
(origin + id, no widget_uuid) with `symbol`, `start_date`, `end_date`.
- For a general "how is <symbol> doing" question, fetch \
`equity_price_quote_nasdaq_obb` (latest quote) and, when the user wants the \
recent trend or a date range, also `equity_price_historical_nasdaq_obb` - both \
by origin + id with no widget_uuid. Do not answer those questions from a \
`tv_charting` widget unless the user is explicitly asking about that chart.
- Never write `[called tool with {...}]` or any other pseudo tool-call syntax in \
an answer. Tool calls only happen through the tools API.\
- `run_trading_agents` launches a FULL multi-agent research pipeline (analysts, \
Bull/Bear debate, trader, risk debate, portfolio manager). It takes several \
minutes. Only call it when the user explicitly asks for a deep/full/comprehensive \
analysis or says "跑 TradingAgents". Do not call it for quick price questions — \
use `get_widget_data` instead. Never call it twice in one conversation turn.
- After `run_trading_agents` returns, present the result as: rating + \
confidence first, then the trade plan (direction / entry / stop), then a short \
summary of each analyst report that supports the conclusion.
- Reply in the language the user writes in (Chinese in, Chinese out).
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
    """Hidden function-call AI messages look like {"function": ..., ...}.

    Rendered as plain prose on purpose: an earlier bracketed rendering
    (`[called get_widget_data with {...}]`) was copied verbatim by MiniMax as a
    normal answer, so the chat showed a fake tool call instead of data.
    """
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
    if args:
        return (
            f"I already called the {name} tool with these arguments: "
            f"{_json_block(args, 600)}"
        )
    return f"I already called the {name} tool."


# A model can echo a tool call as plain text instead of emitting a real one.
# When that happens the chat shows `[called get_widget_data with {...}]` and no
# data is fetched. Detect the shape so the adapter can execute it instead.
LEAKED_CALL_RE = re.compile(
    r"^\s*\[called\s+([A-Za-z_][\w.]*)\s+with\s+(\{.*\})\]\s*$", re.S
)


def parse_leaked_call(text: str) -> tuple[str, dict[str, Any]] | None:
    """Return (function_name, arguments) when `text` is an echoed tool call."""
    match = LEAKED_CALL_RE.match(text or "")
    if not match:
        return None
    try:
        arguments = json.loads(match.group(2))
    except Exception:
        return None
    if not isinstance(arguments, dict):
        return None
    return match.group(1), arguments


def leak_guard(
    hold: str | None, piece: str
) -> tuple[str | None, str | None]:
    """Buffer text that might be a leaked tool call.

    `hold` is the text withheld so far, or None once the answer is known to be
    ordinary prose. Returns the new hold and the text (if any) that is safe to
    stream now.
    """
    if hold is None:
        return None, piece
    buffered = hold + piece
    stripped = buffered.lstrip()
    prefix = "[called"
    if stripped.startswith(prefix):
        return buffered, None
    if prefix.startswith(stripped[: len(prefix)]) and "\n" not in stripped:
        return buffered, None
    return None, buffered



def _collect_tables(obj: Any, found: list[list[dict[str, Any]]], depth: int = 0) -> None:
    """Find row lists (list[dict]) anywhere inside a widget payload."""
    if depth > 5 or len(found) >= 3:
        return
    if isinstance(obj, list):
        if obj and all(isinstance(row, dict) for row in obj) and len(obj[0]) >= 2:
            found.append(obj)
            return
        for item in obj[:5]:
            _collect_tables(item, found, depth + 1)
    elif isinstance(obj, dict):
        for value in obj.values():
            _collect_tables(value, found, depth + 1)


def _table_to_markdown(rows: list[dict[str, Any]], max_rows: int = 40, max_cols: int = 10) -> str:
    columns = list(rows[0].keys())[:max_cols]
    header = "| " + " | ".join(str(c) for c in columns) + " |"
    divider = "|" + "|".join("---" for _ in columns) + "|"
    lines = [header, divider]
    for row in rows[:max_rows]:
        cells = []
        for col in columns:
            value = row.get(col, "")
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False, default=str)[:60]
            cells.append(str(value).replace("|", "\\|")[:80])
        lines.append("| " + " | ".join(cells) + " |")
    if len(rows) > max_rows:
        lines.append(f"…({len(rows) - max_rows} more rows omitted)")
    return "\n".join(lines)


def render_tool_result(raw: Any, budget: int = 12000) -> str:
    """Pretty-print a `get_widget_data` result: tables first, JSON as fallback."""
    tables: list[list[dict[str, Any]]] = []
    _collect_tables(raw, tables)
    if tables:
        rendered = "\n\n".join(_table_to_markdown(t) for t in tables)
        if len(rendered) > budget:
            rendered = rendered[:budget] + " …[truncated]"
        return rendered
    return _json_block(raw, budget)


def _render_widget(widget: dict[str, Any], budget: int) -> str:
    """Render one widget as a catalogue entry the model can pass back to
    `get_widget_data`. Workspace sends metadata only — never the values."""
    name = widget.get("name") or widget.get("widget_id") or "Widget"
    widget_id = widget.get("widget_id") or ""
    origin = widget.get("origin") or ""
    uuid = widget.get("uuid") or ""
    description = (widget.get("description") or "").strip()

    header = f"- **{name}**"
    lines = [header]
    if description:
        lines.append(f"  description: {description[:300]}")
    if origin:
        lines.append(f"  origin: `{origin}`")
    if widget_id:
        lines.append(f"  id: `{widget_id}`")
    if uuid:
        lines.append(f"  widget_uuid: `{uuid}`")

    params = widget.get("params")
    current: dict[str, Any] = {}
    if isinstance(params, list):
        for param in params:
            if not isinstance(param, dict):
                continue
            key = param.get("name")
            value = param.get("current_value", param.get("default_value"))
            if key and value not in (None, ""):
                current[key] = value
    elif isinstance(params, dict):
        current = params
    if current:
        lines.append("  input_args: " + _json_block(current, min(600, budget)))

    columns = widget.get("columns")
    if isinstance(columns, list) and columns:
        lines.append("  columns: " + _json_block(columns, 300))

    data = None
    for key in ("data", "widget_data", "results", "result"):
        if widget.get(key) not in (None, "", [], {}):
            data = widget[key]
            break
    if data is not None:
        lines.append("  data (already loaded): " + _json_block(data, budget))

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
        "Widgets the user attached to this chat (call `get_widget_data` to read them)",
        primary,
        "These were pinned to the conversation on purpose — read them before answering.",
        widget_max_chars,
    )
    add_section(
        "Other widgets on the active dashboard",
        secondary,
        "Also readable through `get_widget_data`; use when relevant.",
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

    # Names of everything on the dashboard (Workspace always sends these even
    # when the per-widget metadata arrays are empty). Useful so the model can
    # tell the user which widget to attach instead of saying "I see nothing".
    if isinstance(dashboard_info, dict) and budget > 300:
        names: list[str] = []
        for tab in dashboard_info.get("tabs") or []:
            if not isinstance(tab, dict):
                continue
            tab_name = tab.get("tab_name") or tab.get("tab_id") or ""
            for item in tab.get("widgets") or []:
                if isinstance(item, dict) and item.get("name"):
                    names.append(f"{item['name']} [{tab_name}]" if tab_name else item["name"])
        names = list(dict.fromkeys(names))[:40]
        if names:
            parts.append(
                "## Dashboard contents (names only — attach one to the chat or "
                "call `get_widget_data` if it appears above)\n"
                + "\n".join(f"- {n}" for n in names)
            )
            budget -= len(names) * 40

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
            args = raw.get("input_arguments")
            header = f"[tool result: {function}]"
            if args:
                header += f" arguments={_json_block(args, 400)}"
            messages.append(
                {
                    "role": "user",
                    "content": f"{header}\n{render_tool_result(raw.get('data'))}",
                }
            )
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


# Bare endpoint names models tend to shorten ids to. The local OpenBB Platform
# backend registers widgets as `<endpoint path>_<provider>_obb`, so a bare
# `equity_price_historical` resolves to nothing and used to fall back to an
# unrelated widget's cached rows. Rewrite the handful we know are safe.
BARE_ID_ALIASES = {
    "equity_price_historical": "equity_price_historical_nasdaq_obb",
    "equity_price_quote": "equity_price_quote_nasdaq_obb",
    "equity_fundamental_income_statement": "equity_fundamental_income_nasdaq_obb",
    "equity_fundamental_balance_sheet": "equity_fundamental_balance_nasdaq_obb",
    "equity_fundamental_cash_flow": "equity_fundamental_cash_nasdaq_obb",
}


def normalize_get_widget_args(
    arguments: dict[str, Any], sources: list[dict[str, Any]]
) -> dict[str, Any]:
    """Make model-produced `get_widget_data` arguments satisfy Workspace's zod
    schema: every data source needs origin, id and an `input_args` object.

    Missing pieces are filled from the widget catalogue we already sent, and
    unknown widgets are dropped instead of failing the whole call.
    """
    raw_sources = arguments.get("data_sources")
    if not isinstance(raw_sources, list) or not raw_sources:
        return arguments

    by_key: dict[tuple[str, str], dict[str, Any]] = {}
    by_id: dict[str, dict[str, Any]] = {}
    by_uuid: dict[str, dict[str, Any]] = {}
    for source in sources:
        by_key[(source.get("origin", ""), source.get("id", ""))] = source
        by_id.setdefault(source.get("id", ""), source)
        if source.get("widget_uuid"):
            by_uuid[source["widget_uuid"]] = source

    normalized: list[dict[str, Any]] = []
    for item in raw_sources:
        if not isinstance(item, dict):
            continue
        origin = item.get("origin") or ""
        widget_id = item.get("id") or ""
        widget_id = BARE_ID_ALIASES.get(widget_id, widget_id)
        match = by_key.get((origin, widget_id)) or by_id.get(widget_id)
        if match:
            origin = origin or match.get("origin", "")
            widget_id = widget_id or match.get("id", "")
        # A uuid identifies one specific widget instance. If the model paired it
        # with a different id (e.g. reused the quote widget's uuid for a
        # historical request), drop the uuid so Workspace resolves the requested
        # id against the backend registry instead of returning the other
        # widget's cached rows.
        widget_uuid = item.get("widget_uuid")
        if widget_uuid:
            owner = by_uuid.get(widget_uuid)
            if owner is not None and owner.get("id") != widget_id:
                widget_uuid = None
        if not widget_uuid:
            widget_uuid = (match or {}).get("widget_uuid")
        args = item.get("input_args")
        if not isinstance(args, dict) or not args:
            args = dict((match or {}).get("input_args") or {})
        elif match is not None:
            # A catalogue widget only understands the parameters it declares
            # (tv_charting declares none: it always shows the symbol selected
            # inside it). Silently forwarding extra args made the model believe
            # it had fetched another symbol, so keep the declared keys only.
            declared = set(match.get("input_args") or {})
            args = {key: value for key, value in args.items() if key in declared}
        entry: dict[str, Any] = {
            "widget_uuid": widget_uuid,
            "origin": origin,
            "id": widget_id,
            "input_args": args,
        }
        if item.get("ssm_request") is not None:
            entry["ssm_request"] = item["ssm_request"]
        normalized.append(entry)

    if normalized:
        arguments = dict(arguments)
        arguments["data_sources"] = normalized
    return arguments


def widget_sources(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Data sources the model is allowed to request via `get_widget_data`."""
    widgets = payload.get("widgets") or {}
    sources: list[dict[str, Any]] = []
    for group in ("primary", "secondary"):
        for widget in widgets.get(group) or []:
            if not isinstance(widget, dict):
                continue
            origin = widget.get("origin")
            widget_id = widget.get("widget_id")
            if not origin or not widget_id:
                continue
            args: dict[str, Any] = {}
            params = widget.get("params")
            if isinstance(params, list):
                for param in params:
                    if isinstance(param, dict) and param.get("name"):
                        value = param.get("current_value", param.get("default_value"))
                        if value not in (None, ""):
                            args[param["name"]] = value
            elif isinstance(params, dict):
                args = params
            sources.append(
                {
                    "widget_uuid": widget.get("uuid"),
                    "origin": origin,
                    "id": widget_id,
                    "name": widget.get("name") or widget_id,
                    "input_args": args,
                }
            )
    return sources


def tool_call_count(payload: dict[str, Any]) -> int:
    """Widget-data round trips in the CURRENT turn only.

    Counting the whole chat history would permanently exhaust the tool budget
    after a few exchanges (the frontend replays every historical tool result
    in each request), so only messages after the last human message count.
    """
    messages = payload.get("messages") or []
    last_human = -1
    for idx, raw in enumerate(messages):
        if isinstance(raw, dict) and raw.get("role") == "human":
            last_human = idx
    return sum(
        1
        for raw in messages[last_human + 1 :]
        if isinstance(raw, dict) and raw.get("role") == "tool"
    )
