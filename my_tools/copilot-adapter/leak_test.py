"""Offline checks for the echoed-tool-call guard and widget-arg normalisation.

Covers the two failures seen in the wild:
  1. MiniMax prints `[called get_widget_data with {...}]` as plain text, so the
     chat shows a fake tool call and no data is fetched.
  2. A chart widget (`tv_charting`) accepts `symbol` but can never honour it,
     which made the model believe it had read another symbol's rows.

Run: python leak_test.py
"""

from __future__ import annotations

import json

from translate import leak_guard, normalize_get_widget_args, parse_leaked_call

LEAK = (
    '[called get_widget_data with {"data_sources": [{"origin": "OpenBB Sandbox", '
    '"id": "tv_charting", "input_args": {"symbol": "SNDK"}}]}]'
)


def check_parse() -> None:
    parsed = parse_leaked_call(LEAK)
    assert parsed is not None, "leaked call not recognised"
    name, args = parsed
    assert name == "get_widget_data", name
    assert args["data_sources"][0]["input_args"]["symbol"] == "SNDK"
    print("ok  parse_leaked_call")


def check_guard_holds_chunks() -> None:
    hold: str | None = ""
    emitted: list[str] = []
    for char in LEAK:
        hold, out = leak_guard(hold, char)
        if out:
            emitted.append(out)
    assert hold == LEAK, f"expected the whole echo to be held, got {hold!r}"
    assert not emitted, f"leaked text was streamed: {emitted}"
    print("ok  leak_guard holds a chunked echo")


def check_guard_passes_prose() -> None:
    assert leak_guard("", "[注意] 今天休市") == (None, "[注意] 今天休市")
    assert leak_guard("", "收盘价 1378.22") == (None, "收盘价 1378.22")
    print("ok  leak_guard passes ordinary prose")


def check_args_filtered_by_catalogue() -> None:
    catalogue = [
        {
            "widget_uuid": "chart-uuid",
            "origin": "OpenBB Sandbox",
            "id": "tv_charting",
            "input_args": {},
        },
        {
            "widget_uuid": "quote-uuid",
            "origin": "OpenBB Platform (local 6900)",
            "id": "equity_price_quote_nasdaq_obb",
            "input_args": {"symbol": ["AAPL", "NVDA"], "provider": "nasdaq"},
        },
    ]
    arguments = {
        "data_sources": [
            {
                "widget_uuid": "chart-uuid",
                "origin": "OpenBB Sandbox",
                "id": "tv_charting",
                "input_args": {"symbol": "SNDK"},
            },
            {
                "widget_uuid": "quote-uuid",
                "origin": "OpenBB Platform (local 6900)",
                "id": "equity_price_quote_nasdaq_obb",
                "input_args": {"symbol": ["SNDK"], "provider": "nasdaq"},
            },
        ]
    }
    out = normalize_get_widget_args(arguments, catalogue)["data_sources"]
    assert out[0]["input_args"] == {}, out[0]["input_args"]
    assert out[1]["input_args"]["symbol"] == ["SNDK"], out[1]["input_args"]
    print("ok  undeclared args dropped, declared args kept")


def check_uuid_paired_with_other_widget_is_stripped() -> None:
    catalogue = [
        {
            "widget_uuid": "quote-uuid",
            "origin": "OpenBB Platform (local 6900)",
            "id": "equity_price_quote_nasdaq_obb",
            "input_args": {"symbol": ["AAPL"]},
        }
    ]
    arguments = {
        "data_sources": [
            {
                "widget_uuid": "quote-uuid",
                "origin": "OpenBB Platform (local 6900)",
                "id": "equity_price_historical",
                "input_args": {"symbol": "SNDK"},
            }
        ]
    }
    (out,) = normalize_get_widget_args(arguments, catalogue)["data_sources"]
    assert out["widget_uuid"] is None, out
    assert out["id"] == "equity_price_historical_nasdaq_obb", out
    print("ok  mispaired uuid dropped, bare id aliased")


if __name__ == "__main__":
    check_parse()
    check_guard_holds_chunks()
    check_guard_passes_prose()
    check_args_filtered_by_catalogue()
    check_uuid_paired_with_other_widget_is_stripped()
    print(json.dumps({"ok": True}))
