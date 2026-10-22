"""The secret scanner: names around password/secret/token words, unquoted env lines, and keys with dashes."""

from __future__ import annotations

import pytest

from keel_engine.rules import checks

REAL = "Zq8mL2vR9xT4wKp7Yn3B"   # keel:allow-secret (fixture: a random-looking value)


@pytest.mark.parametrize("line", [
    f'DB_PASSWORD="{REAL}"',   # keel:allow-secret
    f"STRIPE_SECRET_KEY='{REAL}'",   # keel:allow-secret
    f'dbPassword: "{REAL}"',   # keel:allow-secret
    f'const clientSecret = "{REAL}";',   # keel:allow-secret
    f'"api_key": "{REAL}"',   # keel:allow-secret
    f'AWS_ACCESS_KEY_ID_TOKEN = "{REAL}"',   # keel:allow-secret
    f"DB_PASSWORD={REAL}",   # keel:allow-secret
    f"export STRIPE_SECRET_KEY={REAL}",   # keel:allow-secret
    "key = sk-ant-api03-AbCdEf0123456789xYzQrStUv",   # keel:allow-secret
    "key = sk-proj-AbCdEf0123456789xYzQrStUvWxYz",   # keel:allow-secret
    "key = sk-AbCdEf0123456789xYzQrStUv",   # keel:allow-secret
])
def test_secret_is_found(line):
    # the marker in the source line above is for the repo's own scan; the scanned text is only the string
    assert checks.scan_secrets(line.split("   # keel:allow-secret")[0]), line


@pytest.mark.parametrize("line", [
    'DB_PASSWORD="changeme-please-now"',
    "DB_PASSWORD=changeme-please-now",
    'dbPassword: "${DB_PASSWORD_FROM_VAULT}"',
    "DB_PASSWORD=${DB_PASSWORD_FROM_VAULT}",
    "STRIPE_SECRET_KEY=$(cat /run/secrets/stripe_key_file)",
    'api_key = "<your api key goes here>"',
    'password = "xxxxxxxxxxxxxxxx"',
    'password = ""',
    "DB_PASSWORD=",
    'tokenizer = "aaaaaaaaaaaaaaaaaaaa"',
    'password = "short"',
    "sk-learn-pipeline-transformer-selector",
    "# set DB_PASSWORD in your shell before running",
    f'DB_PASSWORD="{REAL}"  # keel:allow-secret',
])
def test_placeholder_or_harmless_line_is_not_flagged(line):
    assert checks.scan_secrets(line) == [], line
