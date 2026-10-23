"""Google Vertex AI, provider `vertex`: Claude (Anthropic on Vertex) and Gemini models in the person's Google Cloud
project.

The api sends the connection as the provider's key (StartThread.keys["vertex"], POST /providers/test's key), a JSON:

    {"project": "my-project", "region": "global", "credentials": {…service-account JSON…} (optional)}

Without credentials keel uses Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS, gcloud's ADC, or the
machine's service account). Claude goes through the Anthropic SDK's AnthropicVertex client under LangChain's
ChatAnthropic (efforts as in the Anthropic API mode); Gemini through Vertex's OpenAI-compatible endpoint with
ChatOpenAI and a short-lived Google access token. Usage and cost come from the replies' token counts.
"""

from __future__ import annotations

import json
import re
import threading

from .base import ModelError

SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
HINT_SETUP = "Set the project and region in Connections › Vertex AI, and a service-account key unless keel has Google's ADC."

# Current ids on Vertex: current Claude models use the bare first-party id, an older dated one takes @<date>.
CLAUDE = [
    {"id": "claude-opus-5-5", "label": "Claude Opus 5.5"},
    {"id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5"},
    {"id": "claude-haiku-5-5", "label": "Claude Haiku 5.5"},
    {"id": "claude-fable-5-1", "label": "Claude Fable 5.1"},
    {"id": "claude-opus-5", "label": "Claude Opus 5"},
    {"id": "claude-sonnet-5", "label": "Claude Sonnet 5"},
    {"id": "claude-haiku-4-5@20251001", "label": "Claude Haiku 4.5"},
]
GEMINI = [
    {"id": "gemini-3-pro-preview", "label": "Gemini 3 Pro (preview)"},
    {"id": "gemini-3-flash-preview", "label": "Gemini 3 Flash (preview)"},
    {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro"},
    {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash"},
    {"id": "gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash-Lite"},
]


def parse(key: str | dict | None) -> dict:
    if not key:
        return {}
    if isinstance(key, dict):
        return key
    try:
        cfg = json.loads(key)
    except (TypeError, json.JSONDecodeError):
        return {}
    return cfg if isinstance(cfg, dict) else {}


def is_claude(model_id: str) -> bool:
    return (model_id or "").lower().startswith(("claude", "anthropic/"))


def efforts(model_id: str) -> list[str]:
    """Claude on Vertex takes the Anthropic API's efforts (Haiku before 5 none); Gemini none."""
    from .catalog import CLAUDE_EFFORTS

    m = (model_id or "").lower()
    if not is_claude(m):
        return []
    return [] if "haiku" in m and not re.search(r"haiku-[5-9]", m) else list(CLAUDE_EFFORTS)


def _need(cfg: dict) -> tuple[str, str]:
    project, region = str(cfg.get("project") or "").strip(), str(cfg.get("region") or "").strip()
    if not project or not region:
        raise ModelError("Vertex AI is not set up: it needs a project and a region.", HINT_SETUP)
    return project, region


def credentials(cfg: dict):
    """Google credentials: the service-account key in the config, else Application Default Credentials."""
    try:
        import google.auth
        from google.oauth2 import service_account
    except ImportError as exc:  # anthropic[vertex] brings google-auth
        raise ModelError("keel's engine has no google-auth library.", "Update keel: the Vertex AI provider needs it.") from exc
    info = cfg.get("credentials")
    if isinstance(info, str) and info.strip():
        try:
            info = json.loads(info)
        except json.JSONDecodeError as exc:
            raise ModelError("The Vertex AI service-account key is not JSON.", "Paste the whole key file again.") from exc
    if isinstance(info, dict) and info:
        try:
            return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
        except (ValueError, KeyError) as exc:
            raise ModelError("The Vertex AI service-account key is not valid.", "Create a new JSON key for the service account and paste it.") from exc
    try:
        creds, _ = google.auth.default(scopes=SCOPES)
    except Exception as exc:  # noqa: BLE001 - DefaultCredentialsError and friends
        raise ModelError("keel found no Google credentials for Vertex AI.",
                         "Paste a service-account key in Connections › Vertex AI, or give keel Application Default Credentials.") from exc
    return creds


def api_host(region: str) -> str:
    if region == "global":
        return "https://aiplatform.googleapis.com"
    if region in ("us", "eu"):
        return f"https://aiplatform.{region}.rep.googleapis.com"
    return f"https://{region}-aiplatform.googleapis.com"


def openai_base(project: str, region: str) -> str:
    return f"{api_host(region)}/v1/projects/{project}/locations/{region}/endpoints/openapi"


class _Token:
    """A Google access token that renews itself before it runs out (a flow can run longer than the hour one lasts)."""

    def __init__(self, creds):
        self.creds = creds
        self.lock = threading.Lock()

    def __call__(self) -> str:
        with self.lock:
            if not self.creds.valid:
                from google.auth.transport.requests import Request

                self.creds.refresh(Request())
            return self.creds.token


def claude_class():
    """ChatAnthropic whose client is the Anthropic SDK's AnthropicVertex (same messages API, Google auth)."""
    from functools import cached_property
    from typing import Any

    from anthropic import AnthropicVertex, AsyncAnthropicVertex
    from langchain_anthropic import ChatAnthropic

    class ChatAnthropicVertex(ChatAnthropic):
        vertex_project: str = ""
        vertex_region: str = ""
        vertex_credentials: Any = None

        @cached_property
        def _client(self):
            return AnthropicVertex(project_id=self.vertex_project, region=self.vertex_region, credentials=self.vertex_credentials,
                                   max_retries=self.max_retries, timeout=self.default_request_timeout)

        @cached_property
        def _async_client(self):
            return AsyncAnthropicVertex(project_id=self.vertex_project, region=self.vertex_region,
                                        credentials=self.vertex_credentials, max_retries=self.max_retries,
                                        timeout=self.default_request_timeout)

    return ChatAnthropicVertex


def chat_model(key: str | dict | None, model_id: str, effort: str | None = None):
    cfg = parse(key)
    if not cfg:
        raise ModelError("Vertex AI is not set up.", HINT_SETUP)
    project, region = _need(cfg)
    creds = credentials(cfg)
    model_id = model_id or "claude-sonnet-5-5"
    if is_claude(model_id):
        kw = {"output_config": {"effort": effort}} if effort else {}
        cls = claude_class()
        # api_key: ChatAnthropic wants one; the Vertex client authenticates with Google and never sends it
        return cls(model=model_id.removeprefix("anthropic/"), api_key="vertex", max_tokens=16000, timeout=600,
                   vertex_project=project, vertex_region=region, vertex_credentials=creds, **kw)
    from langchain_openai import ChatOpenAI

    token = _Token(creds)
    model = model_id if "/" in model_id else f"google/{model_id}"
    return ChatOpenAI(model=model, api_key=token, base_url=openai_base(project, region), timeout=600, stream_usage=True)


def catalog_entry(key: str | dict | None) -> dict | None:
    """The provider `vertex` for GET /providers/models (built-in lists), when a project and region are set."""
    cfg = parse(key)
    if not str(cfg.get("project") or "").strip() or not str(cfg.get("region") or "").strip():
        return None
    from .catalog import CLAUDE_EFFORTS

    models = [{**m, "efforts": efforts(m["id"])} for m in CLAUDE] + [{**m, "efforts": []} for m in GEMINI]
    return {"label": "Vertex AI", "modes": {"api": models}, "efforts": list(CLAUDE_EFFORTS),
            "default": {"mode": "api", "model": "claude-sonnet-5-5", "effort": "high"}, "source": "builtin"}
