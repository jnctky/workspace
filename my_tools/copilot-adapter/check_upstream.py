"""Check that the configured upstream + API key actually work.

    python check_upstream.py

Sends one tiny non-streaming request and prints the reply (or a clear error).
Run this right after filling in .env, before touching the Workspace UI.
"""

from __future__ import annotations

import json
import sys

import httpx

from settings import settings


def main() -> int:
    url = settings.upstream_url()
    print(f"upstream : {url}")
    print(f"model    : {settings.model}")
    print(f"api key  : {'set (' + settings.api_key[:6] + '…)' if settings.api_key else 'MISSING'}")
    print(f"proxy    : {settings.upstream_proxy or 'none (trust_env disabled)'}")
    print()

    if not settings.api_key:
        print("!! 未配置 OPENAI_API_KEY，先编辑 .env")
        return 2

    kwargs = {"timeout": 90.0, "trust_env": False}
    if settings.upstream_proxy:
        kwargs["proxy"] = settings.upstream_proxy

    body = {
        "model": settings.model,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "max_tokens": 32,
        "stream": False,
    }
    headers = {
        "Authorization": f"Bearer {settings.api_key}",
        "Content-Type": "application/json",
    }

    try:
        resp = httpx.post(url, json=body, headers=headers, **kwargs)
    except httpx.HTTPError as exc:
        print(f"!! 连接失败: {type(exc).__name__}: {exc}")
        print("   国内连 api.minimax.io 请在 .env 设 UPSTREAM_PROXY=http://127.0.0.1:10808")
        return 3

    print(f"HTTP {resp.status_code}")
    try:
        data = resp.json()
    except json.JSONDecodeError:
        print(resp.text[:800])
        return 1

    if resp.status_code >= 400:
        print(json.dumps(data, ensure_ascii=False, indent=2)[:1200])
        if resp.status_code == 401:
            print("\n!! Key 无效 / 未授权，检查 MiniMax 控制台里的 Token")
        return 1

    choices = data.get("choices") or []
    if choices:
        message = choices[0].get("message") or {}
        print("reply    :", (message.get("content") or "").strip()[:300])
    else:
        print(json.dumps(data, ensure_ascii=False)[:800])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
