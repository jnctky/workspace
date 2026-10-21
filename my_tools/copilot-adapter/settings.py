"""Runtime configuration for the OpenAI-compatible Copilot adapter.

All values come from environment variables, optionally loaded from a local
`.env` file next to this module. Nothing is hard-coded to a single vendor so
the same adapter works with MiniMax, DeepSeek, OpenAI, Ollama, LM Studio,
one-api gateways, etc.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")


def _env(name: str, default: str = "") -> str:
    raw = os.getenv(name)
    if raw is None:
        return default
    raw = raw.strip()
    return raw or default


def _env_bool(name: str, default: bool = False) -> bool:
    raw = _env(name, "")
    if not raw:
        return default
    return raw.lower() in {"1", "true", "yes", "on", "y"}


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(float(_env(name, str(default))))
    except ValueError:
        return default


class Settings:
    """Settings snapshot. Restart the service after editing .env."""

    # --- upstream (any OpenAI-compatible endpoint) ---
    base_url: str = _env("OPENAI_BASE_URL", "https://api.minimaxi.com/v1").rstrip("/")
    api_key: str = _env("OPENAI_API_KEY", "")
    model: str = _env("OPENAI_MODEL", "MiniMax-M2.7")
    models_raw: str = _env("OPENAI_MODELS", "")

    temperature: float = _env_float("OPENAI_TEMPERATURE", 0.3)
    max_tokens: int = _env_int("OPENAI_MAX_TOKENS", 4096)
    top_p: float = _env_float("OPENAI_TOP_P", 1.0)

    # --- adapter server ---
    host: str = _env("ADAPTER_HOST", "127.0.0.1")
    port: int = _env_int("ADAPTER_PORT", 7777)

    # --- context budget ---
    context_max_chars: int = _env_int("CONTEXT_MAX_CHARS", 40000)
    widget_max_chars: int = _env_int("WIDGET_MAX_CHARS", 6000)
    attachment_max_chars: int = _env_int("ATTACHMENT_MAX_CHARS", 12000)

    upstream_timeout: float = _env_float("UPSTREAM_TIMEOUT", 300.0)
    upstream_proxy: str = _env("UPSTREAM_PROXY", "")

    # --- reasoning stream (<think> blocks) ---
    # status : fold into a collapsible "step-by-step reasoning" section (default)
    # hide   : drop it entirely
    # inline : keep the raw tags in the answer (old behaviour)
    reasoning_mode: str = _env("REASONING_MODE", "status").lower()
    reasoning_chunk_chars: int = _env_int("REASONING_CHUNK_CHARS", 320)

    # --- widget data tool ---
    # How many get_widget_data round trips are allowed per question before the
    # tool is withdrawn (guards against call loops).
    max_tool_rounds: int = _env_int("MAX_TOOL_ROUNDS", 3)

    # --- TradingAgents deep-analysis tool (server-side executed) ---
    # The adapter runs the TradingAgents pipeline as a subprocess and streams
    # its progress into the chat as status updates.
    ta_enabled: bool = _env_bool("TA_RUNNER_ENABLED", True)
    ta_python: str = _env(
        "TA_RUNNER_PYTHON", r"D:\work\trade\TradingAgents\.venv\Scripts\python.exe"
    )
    ta_script: str = _env(
        "TA_RUNNER_SCRIPT", r"D:\work\trade\TradingAgents\my_tools\ta_runner.py"
    )
    ta_timeout: float = _env_float("TA_RUNNER_TIMEOUT", 1800.0)
    ta_max_calls: int = _env_int("TA_MAX_CALLS_PER_TURN", 1)
    ta_message_max_chars: int = _env_int("TA_MESSAGE_MAX_CHARS", 600)

    # --- identity shown in Workspace ---
    agent_id: str = _env("AGENT_ID", "openai-compatible-copilot")
    agent_name: str = _env("AGENT_NAME", "MiniMax Copilot")
    agent_description: str = _env(
        "AGENT_DESCRIPTION",
        "OpenAI-compatible model wired into OpenBB Workspace. Reads the widgets "
        "on your dashboard as context.",
    )

    # --- optional capabilities (honest defaults) ---
    feature_global_search: bool = _env_bool("FEATURE_GLOBAL_SEARCH", False)
    feature_generative_ui: bool = _env_bool("FEATURE_GENERATIVE_UI", False)
    feature_mcp_tools: bool = _env_bool("FEATURE_MCP_TOOLS", False)

    @classmethod
    def model_list(cls) -> list[str]:
        raw = cls.models_raw or cls.model
        seen: list[str] = []
        for part in raw.replace(";", ",").split(","):
            name = part.strip()
            if name and name not in seen:
                seen.append(name)
        return seen or [cls.model]

    @classmethod
    def upstream_url(cls, override_base: str | None = None) -> str:
        """Full chat-completions URL (OpenAI-compatible surface)."""
        base = (override_base or cls.base_url).rstrip("/")
        if base.endswith("/chat/completions"):
            return base
        return f"{base}/chat/completions"


settings = Settings()
