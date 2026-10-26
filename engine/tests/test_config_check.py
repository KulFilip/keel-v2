"""0.18.57 stale configuration: a command in .keel/config.yml whose compose service, script or target is gone is
reported with the file and line (keel2 doctor, the project's doctor, knowledge-refresh)."""

import json
from pathlib import Path

from keel_engine.runtime import config_check

CONFIG = """version: 4
commands:
  api_test_module: docker compose exec -T app vendor/bin/phpunit
  api_lint: docker compose exec -T php composer cs-check
  static_checks: composer phpstan
  web_test_module: npm run test:unit
  smoke: make smoke
  deps_api: docker compose exec -T app composer install -n
  e2e: ./scripts/e2e.sh
"""


def shop(tmp_path):
    root = tmp_path / "shop"
    (root / ".keel").mkdir(parents=True)
    (root / ".keel" / "config.yml").write_text(CONFIG)
    (root / "compose.yml").write_text("services:\n  app: {image: php}\n  db: {image: mysql}\n")
    (root / "composer.json").write_text(json.dumps({"scripts": {"cs-check": "phpcs"}}))
    (root / "package.json").write_text(json.dumps({"scripts": {"test": "vitest"}}))
    (root / "Makefile").write_text("test:\n\tphpunit\n")
    return root


def test_stale_commands_are_named_with_the_file_and_line(tmp_path):
    root = shop(tmp_path)
    found = {p["key"]: p for p in config_check.stale(str(root))}
    assert set(found) == {"api_lint", "static_checks", "web_test_module", "smoke", "e2e"}
    assert found["api_lint"]["problem"] == "the compose service 'php' is not in compose.yml (services: app, db)"
    assert found["api_lint"]["line"] == 4 and found["api_lint"]["file"] == ".keel/config.yml"
    assert found["static_checks"]["problem"] == "composer.json has no script 'phpstan'"
    assert found["web_test_module"]["problem"] == "package.json has no script 'test:unit'"
    assert found["smoke"]["problem"] == "the Makefile has no target 'smoke'"
    assert found["e2e"]["problem"] == "./scripts/e2e.sh does not exist"
    assert config_check.lines([found["smoke"]]) == [".keel/config.yml:7 commands.smoke: the Makefile has no target 'smoke' (make smoke)"]


def test_a_fixed_config_is_clean_and_the_endpoint_answers(client, tmp_path):
    root = shop(tmp_path)
    (root / "compose.yml").write_text("services:\n  app: {image: php}\n  php: {image: php}\n")
    (root / "composer.json").write_text(json.dumps({"scripts": {"cs-check": "phpcs", "phpstan": "phpstan"}}))
    (root / "package.json").write_text(json.dumps({"scripts": {"test:unit": "vitest"}}))
    (root / "Makefile").write_text("smoke:\n\tcurl x\n")
    (root / "scripts").mkdir()
    (root / "scripts" / "e2e.sh").write_text("#!/bin/sh\n")
    assert config_check.stale(str(root)) == []
    (root / "Makefile").write_text("test:\n\tphpunit\n")
    r = client.get("/config-check", params={"root": str(root)})
    assert r.status_code == 200 and r.json()["lines"][0].startswith(".keel/config.yml:7 commands.smoke:")
