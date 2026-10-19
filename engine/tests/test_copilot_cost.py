"""keel 0.18.16: a Copilot call costs premium requests × the model's multiplier × the price of a premium request.
Before, every Copilot call showed $0 (keel priced only tokens, and only in API-key mode)."""
import json

from keel_engine.models import catalog


def test_a_copilot_call_costs_its_premium_requests():
    assert catalog.premium_cost("copilot", "claude-sonnet-4.5", 1) == 0.04
    assert catalog.premium_cost("copilot", "claude-sonnet-4.5", 3) == 0.12


def test_a_model_included_in_the_plan_costs_nothing():
    assert catalog.premium_cost("copilot", "gpt-4.1", 5) == 0


def test_providers_without_premium_requests_cost_nothing_here():
    assert catalog.premium_cost("claude", "sonnet", 4) == 0


def test_the_multiplier_and_price_come_from_prices_json(tmp_path, monkeypatch):
    monkeypatch.setattr(catalog.config, "data_dir", lambda: str(tmp_path))
    (tmp_path / "prices.json").write_text(json.dumps({"copilot:claude-opus-4.1": {"in": 0, "out": 0, "premium": 10, "premium_usd": 0.04}}))
    assert catalog.premium_cost("copilot", "claude-opus-4.1", 2) == 0.8
