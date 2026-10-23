"""Local models: a model server on this computer or the network (Ollama, LM Studio, vLLM, llama.cpp server, any
OpenAI-compatible URL), provider `local`.

The api sends the endpoints as the provider's key (StartThread.keys["local"], POST /providers/test's key), a JSON:

    {"enabled": true, "endpoints": [{"name": "ollama", "kind": "ollama", "url": "http://host.docker.internal:11434",
                                     "key": "…" (optional), "context": 8192 (optional), "price_in": 0, "price_out": 0}]}

A model id is "<endpoint>/<model>" (ollama/llama3.1:8b); with one endpoint the bare model works too. Chat goes through
the server's OpenAI-compatible endpoint (Ollama's /v1) with LangChain's ChatOpenAI; usage comes from the reply.

Tool calls: an agent that writes code needs them. Ollama says what a model can do (/api/show capabilities); for the
other servers keel sends one tiny tool-call request per model and remembers the answer ($KEEL_DATA/local-models.json).
A model without tool calls runs only ask-type calls (KeelBot Ask, summaries, the review check) — a code step is refused.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from pathlib import Path

import httpx

from .. import config
from .base import ModelError

log = logging.getLogger(__name__)

KINDS = ("ollama", "lmstudio", "vllm", "llamacpp", "openai-compatible")
DEFAULT_CONTEXT = 8192          # when neither the server nor the endpoint says
PROBE_TIMEOUT = 4.0             # listing models and model info
TOOL_PROBE_TIMEOUT = 90.0       # the tool-call probe may have to load the model first
CHARS_PER_TOKEN = 4             # the estimate keel packs prompts with

HINT_SETUP = "Add a local model server in Connections › Local models, and turn local models on."


# ------------------------------------------------------------------ config

def parse(key: str | dict | None) -> dict:
    """The endpoints config from the provider's key (a JSON string, or already a dict); {} when there is none."""
    if not key:
        return {}
    if isinstance(key, dict):
        return key
    try:
        cfg = json.loads(key)
    except (TypeError, json.JSONDecodeError):
        return {}
    return cfg if isinstance(cfg, dict) else {}


def endpoints(cfg: dict) -> list[dict]:
    out = []
    for e in cfg.get("endpoints") or []:
        if isinstance(e, dict) and e.get("name") and e.get("url"):
            out.append(e)
    return out


def split(cfg: dict, model_id: str) -> tuple[dict, str]:
    """(endpoint, model) for a catalog id "<endpoint>/<model>"; a bare model uses the only endpoint there is."""
    eps = endpoints(cfg)
    if not eps:
        raise ModelError("No local model server is set up.", HINT_SETUP)
    name, _, rest = (model_id or "").partition("/")
    for e in eps:
        if rest and e["name"] == name:
            return e, rest
    if len(eps) == 1 and model_id:
        return eps[0], model_id
    raise ModelError(f"No local model server called \"{name}\" for the model {model_id}.",
                     "Pick the model again in the model picker: its id is <server>/<model>.")


def root_url(ep: dict) -> str:
    return str(ep.get("url") or "").strip().rstrip("/")


def openai_base(ep: dict) -> str:
    """The OpenAI-compatible base URL: Ollama's and the others' /v1 (added when the URL has none); an
    openai-compatible endpoint is taken as it is."""
    url = root_url(ep)
    if ep.get("kind") == "openai-compatible":
        return url
    if ep.get("kind") == "ollama" and url.endswith("/v1"):
        return url
    return url if url.endswith("/v1") else url + "/v1"


def ollama_root(ep: dict) -> str:
    url = root_url(ep)
    return url[:-3] if url.endswith("/v1") else url


def _headers(ep: dict) -> dict:
    return {"Authorization": f"Bearer {ep['key']}"} if ep.get("key") else {}


def _fingerprint(ep: dict) -> str:
    """Names one endpoint in a cache key without its secret."""
    raw = f"{ep.get('kind')}|{root_url(ep)}|{ep.get('key') or ''}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


# ------------------------------------------------------------------ the server's models

def _get(url: str, ep: dict, timeout: float = PROBE_TIMEOUT) -> dict:
    r = httpx.get(url, headers=_headers(ep), timeout=timeout)
    r.raise_for_status()
    return r.json()


def _post(url: str, ep: dict, body: dict, timeout: float = PROBE_TIMEOUT) -> httpx.Response:
    return httpx.post(url, headers=_headers(ep), json=body, timeout=timeout)


def fetch_models(ep: dict) -> list[dict]:
    """The models the server has, asked now: [{id, label, context?}] (Ollama GET /api/tags, others GET /v1/models).
    Raises on a server that does not answer."""
    if ep.get("kind") == "ollama":
        data = _get(ollama_root(ep) + "/api/tags", ep)
        out = []
        for m in data.get("models") or []:
            name = m.get("name") or m.get("model")
            if not name:
                continue
            size = (m.get("details") or {}).get("parameter_size")
            out.append({"id": name, "label": f"{name} ({size})" if size else name})
        return out
    data = _get(openai_base(ep) + "/models", ep)
    out = []
    for m in data.get("data") or []:
        mid = m.get("id") if isinstance(m, dict) else None
        if not mid:
            continue
        item = {"id": mid, "label": mid}
        ctx = m.get("max_model_len") or m.get("context_length") or m.get("max_context_length")
        if isinstance(ctx, int) and ctx > 0:
            item["context"] = ctx
        out.append(item)
    return out


def list_models(ep: dict) -> list[dict] | None:
    """fetch_models, cached like the other probes (catalog._cached): None when the server did not answer."""
    from . import catalog

    return catalog._cached(("local-models", _fingerprint(ep)), lambda: fetch_models(ep))


def fetch_info(ep: dict, model: str) -> dict:
    """What the server says about one model: {context?, tools?} (Ollama POST /api/show). {} for the other servers."""
    if ep.get("kind") != "ollama":
        return {}
    r = _post(ollama_root(ep) + "/api/show", ep, {"model": model})
    r.raise_for_status()
    data = r.json()
    out: dict = {}
    caps = data.get("capabilities")
    if isinstance(caps, list):
        out["tools"] = "tools" in caps
    # the window Ollama really runs the model with: its num_ctx parameter when the Modelfile sets one, else what the
    # model was trained for (Ollama itself may still use less; the endpoint's own context setting wins over both)
    m = re.search(r"(?m)^\s*num_ctx\s+(\d+)", str(data.get("parameters") or ""))
    if m:
        out["context"] = int(m.group(1))
    else:
        for k, v in (data.get("model_info") or {}).items():
            if k.endswith(".context_length") and isinstance(v, int) and v > 0:
                out["context"] = v
                break
    return out


def model_info(ep: dict, model: str) -> dict:
    from . import catalog

    return catalog._cached(("local-info", _fingerprint(ep), model), lambda: fetch_info(ep, model)) or {}


def context_for(ep: dict, model: str) -> int:
    """The context window keel packs prompts for: the endpoint's setting, else the server's, else DEFAULT_CONTEXT."""
    own = ep.get("context")
    if isinstance(own, (int, float)) and own > 0:
        return int(own)
    info = model_info(ep, model)
    if info.get("context"):
        return int(info["context"])
    for m in list_models(ep) or []:
        if m.get("id") == model and m.get("context"):
            return int(m["context"])
    return DEFAULT_CONTEXT


# ------------------------------------------------------------------ tool calls: probed once per model, remembered

_tools_lock = threading.Lock()
_tools_memo: dict[str, bool] | None = None


def _tools_file() -> Path:
    return Path(config.data_dir()) / "local-models.json"


def _tools_table() -> dict[str, bool]:
    global _tools_memo
    if _tools_memo is None:
        try:
            data = json.loads(_tools_file().read_text())
            _tools_memo = {k: bool(v) for k, v in (data.get("tools") or {}).items()} if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError):
            _tools_memo = {}
    return _tools_memo


def _remember(key: str, value: bool) -> None:
    with _tools_lock:
        table = _tools_table()
        table[key] = value
        try:
            f = _tools_file()
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps({"tools": table}, indent=1, sort_keys=True))
        except OSError as exc:
            log.info("could not write %s: %s", _tools_file(), exc)


def forget_tools() -> None:
    """Tests: forget what was remembered in memory (the file stays)."""
    global _tools_memo
    _tools_memo = None


def _tool_key(ep: dict, model: str) -> str:
    return f"{ep.get('kind')}|{root_url(ep)}|{model}"


PROBE_TOOL = {"type": "function", "function": {"name": "keel_ping", "description": "Answers pong. Call it when asked to ping.",
                                               "parameters": {"type": "object", "properties": {}, "required": []}}}


def probe_tools(ep: dict, model: str) -> bool:
    """One tiny chat request with a tool: True when the model answers with a tool call."""
    body = {"model": model, "messages": [{"role": "user", "content": "Call the keel_ping tool now."}], "tools": [PROBE_TOOL],
            "max_tokens": 64, "stream": False}
    try:
        r = _post(openai_base(ep) + "/chat/completions", ep, body, timeout=TOOL_PROBE_TIMEOUT)
    except httpx.HTTPError as exc:
        raise ModelError(f"The local model server {ep.get('name')} did not answer: {exc}",
                         "Is the server running, and can keel reach its URL? Test it in Connections › Local models.") from exc
    if r.status_code >= 400:
        # a server or model that does not take tools refuses the request ("does not support tools")
        if r.status_code in (400, 422, 500) and re.search(r"tool", r.text, re.I):
            return False
        raise ModelError(f"The local model server {ep.get('name')} answered {r.status_code}: {r.text[:200]}")
    try:
        msg = (r.json().get("choices") or [{}])[0].get("message") or {}
    except (ValueError, AttributeError, IndexError):
        return False
    return bool(msg.get("tool_calls"))


def tools_known(ep: dict, model: str) -> bool | None:
    """What keel knows now without asking the model: Ollama's capabilities, else a remembered probe; None = unknown."""
    key = _tool_key(ep, model)
    with _tools_lock:
        if key in _tools_table():
            return _tools_table()[key]
    if ep.get("kind") == "ollama":
        info = model_info(ep, model)
        if "tools" in info:
            return bool(info["tools"])
    return None


def tool_support(ep: dict, model: str) -> bool:
    """Can this model call tools? Known, else probed once and remembered."""
    known = tools_known(ep, model)
    if known is not None:
        return known
    ok = probe_tools(ep, model)
    _remember(_tool_key(ep, model), ok)
    return ok


def ask_type(req) -> bool:
    """An agent call that only answers (KeelBot Ask, a summary): read-only and outside a flow's phases. A model without
    tool calls may run these; a code step it may not."""
    tb = getattr(req, "toolbox", None)
    return bool(getattr(tb, "readonly", False)) and (getattr(req, "phase", "") or "none") == "none"


def refuse_without_tools(model_id: str, agent: str) -> ModelError:
    return ModelError(f"The local model {model_id} cannot call tools, so it cannot run the {agent or 'agent'} step.",
                      "Pick a model that calls tools for this agent (Agents, or Settings › Models). A model without tool "
                      "calls is offered only for KeelBot Ask, the review check and summaries.")


# ------------------------------------------------------------------ chat

def chat_model(key: str | dict | None, model_id: str):
    cfg = parse(key)
    if not cfg:
        raise ModelError("No local model server is set up.", HINT_SETUP)
    ep, model = split(cfg, model_id)
    from langchain_openai import ChatOpenAI

    # a server without a key still needs one for the client; keel never sends a real key there
    return ChatOpenAI(model=model, api_key=ep.get("key") or "local", base_url=openai_base(ep), timeout=600,
                      stream_usage=True, max_retries=1)


def price(key: str | dict | None, model_id: str) -> dict | None:
    """The price the person set for this endpoint (USD per million tokens), or None: keel's table (local: $0)."""
    try:
        ep, _ = split(parse(key), model_id)
    except ModelError:
        return None
    pin, pout = ep.get("price_in"), ep.get("price_out")
    if pin is None and pout is None:
        return None
    return {"in": float(pin or 0), "out": float(pout or 0)}


# ------------------------------------------------------------------ packing the prompt into the window

def _tokens(text: str) -> int:
    return (len(text or "") + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN


def _cut_middle(text: str, tokens: int) -> str:
    """The text's head and tail within about `tokens`, with a line where the middle was left out."""
    keep = max(tokens, 0) * CHARS_PER_TOKEN
    if len(text) <= keep:
        return text
    mark = "\n\n[… keel left out the middle here: it does not fit the local model's context window …]\n\n"
    if keep <= len(mark) + 40:
        return text[-keep:] if keep > 0 else ""
    head = (keep - len(mark)) * 2 // 3
    tail = keep - len(mark) - head
    return text[:head] + mark + text[-tail:]


def fit(system: str, history: list[tuple[str, str]], prompt: str, window: int, extra_tokens: int = 0) -> tuple[str, list, str, bool]:
    """(system, history, prompt, trimmed) that fit `window` tokens with room for the answer: the oldest turns go first,
    then the middle of the prompt, then the middle of the system prompt. The same idea as the review judge's packing:
    the start and the end of a text say the most."""
    reply = min(4096, max(window // 4, 256))
    room = max(window - reply - extra_tokens, 256)
    hist = list(history or [])

    def size() -> int:
        return _tokens(system) + _tokens(prompt) + sum(_tokens(t) for _, t in hist) + 8 * (len(hist) + 2)

    trimmed = False
    while hist and size() > room:
        hist.pop(0)
        trimmed = True
    if size() > room:
        sys_t = _tokens(system)
        prompt_room = max(room - min(sys_t, room // 3), room // 2)
        if _tokens(prompt) > prompt_room:
            prompt = _cut_middle(prompt, prompt_room)
            trimmed = True
        if size() > room:
            system = _cut_middle(system, max(room - _tokens(prompt), 0))
            trimmed = True
    return system, hist, prompt, trimmed


def tool_tokens(tools: list) -> int:
    """About how many tokens the tools' schemas take in the request."""
    total = 0
    for t in tools or []:
        schema = getattr(t, "args_schema", None)
        try:
            raw = json.dumps(schema.model_json_schema() if hasattr(schema, "model_json_schema") else (schema or {}))
        except Exception:  # noqa: BLE001 - only an estimate
            raw = ""
        total += _tokens(str(getattr(t, "description", "") or "")) + _tokens(raw) + 10
    return total


# ------------------------------------------------------------------ catalog

def catalog_entry(key: str | dict | None) -> dict | None:
    """The provider `local` for GET /providers/models: every endpoint's models as "<endpoint>/<model>", with the
    "local" badge, and tools=false for a model known not to call tools. None when local models are off or not set up."""
    cfg = parse(key)
    if not cfg or cfg.get("enabled") is False:
        return None
    eps = endpoints(cfg)
    if not eps:
        return None
    models: list[dict] = []
    problems: list[str] = []
    for ep in eps:
        found = list_models(ep)
        if found is None:
            problems.append(ep["name"])
            continue
        for m in found:
            item = {"id": f"{ep['name']}/{m['id']}", "label": f"{m.get('label') or m['id']} · {ep['name']}", "efforts": [],
                    "badge": "local"}
            known = tools_known_cached(ep, m["id"])
            if known is not None:
                item["tools"] = known
            ctx = ep.get("context") or m.get("context")
            if ctx:
                item["context"] = int(ctx)
            models.append(item)
    entry = {"label": "Local models", "modes": {"api": models}, "efforts": [],
             "default": {"mode": "api", "model": models[0]["id"] if models else ""}, "source": "server", "badge": "local"}
    if problems:
        entry["problems"] = [f"{n} did not answer" for n in problems]
    return entry


def tools_known_cached(ep: dict, model: str) -> bool | None:
    """tools_known without a request: only what is remembered, or Ollama info already in the cache."""
    from . import catalog

    key = _tool_key(ep, model)
    with _tools_lock:
        if key in _tools_table():
            return _tools_table()[key]
    with catalog._lock:
        hit = catalog._cache.get(("local-info", _fingerprint(ep), model))
    info = hit[1] if hit else None
    if isinstance(info, dict) and "tools" in info:
        return bool(info["tools"])
    return None


def test_endpoint(ep: dict) -> dict:
    """POST /providers/local/test: can keel reach the server, and which models it has (asked now, not cached)."""
    import time

    t0 = time.monotonic()
    try:
        found = fetch_models(ep)
    except httpx.HTTPStatusError as exc:
        return {"ok": False, "ms": int((time.monotonic() - t0) * 1000),
                "error": f"The server answered {exc.response.status_code}.",
                "hint": "Check the URL (Ollama: no /v1; LM Studio, vLLM, llama.cpp: …/v1) and the key."}
    except (httpx.HTTPError, ValueError) as exc:
        return {"ok": False, "ms": int((time.monotonic() - t0) * 1000), "error": f"keel cannot reach {root_url(ep)}: {type(exc).__name__}.",
                "hint": "Is the server running? In Docker, the computer's own servers are at host.docker.internal; "
                        "Ollama must listen on more than 127.0.0.1 (OLLAMA_HOST=0.0.0.0) for a keel on another machine."}
    from . import catalog

    with catalog._lock:   # what the catalog shows from now on
        catalog._cache[("local-models", _fingerprint(ep))] = (time.monotonic(), found)
    return {"ok": True, "ms": int((time.monotonic() - t0) * 1000), "models": found}
