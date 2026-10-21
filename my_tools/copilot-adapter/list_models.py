"""List the models the configured upstream exposes (key read from .env, never printed).

    python list_models.py
"""

from __future__ import annotations

import json

import httpx

from settings import settings


def main() -> int:
    base = settings.base_url.rstrip("/")
    url = f"{base}/models"
    print(f"upstream : {url}")
    print(f"api key  : {'set (' + settings.api_key[:6] + '…)' if settings.api_key else 'MISSING'}")

    kwargs = {"timeout": 30.0, "trust_env": False}
    if settings.upstream_proxy:
        kwargs["proxy"] = settings.upstream_proxy

    try:
        resp = httpx.get(
            url,
            headers={"Authorization": f"Bearer {settings.api_key}"},
            **kwargs,
        )
    except httpx.HTTPError as exc:
        print(f"!! 连接失败: {type(exc).__name__}: {exc}")
        return 3

    print(f"HTTP {resp.status_code}")
    try:
        data = resp.json()
    except json.JSONDecodeError:
        print(resp.text[:600])
        return 1

    ids = [m.get("id") for m in (data.get("data") or []) if isinstance(m, dict)]
    if ids:
        print("models:")
        for i in ids:
            print("  -", i)
    else:
        print(json.dumps(data, ensure_ascii=False)[:800])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
