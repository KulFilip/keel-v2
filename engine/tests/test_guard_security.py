"""Security holes in the command guard found by a review (redirects, force flags, secrets, keel's own files)."""

from __future__ import annotations

import pytest

from keel_engine import rules

TEST_FILE = "apps/api/src/test/kotlin/ATest.kt"


@pytest.mark.parametrize("cmd", [
    f"echo x > {TEST_FILE}",
    f"echo x >{TEST_FILE}",
    f"echo x >>{TEST_FILE}",
    f"echo a >/tmp/x && echo b > {TEST_FILE}",
    f"echo a > /tmp/x && echo b > {TEST_FILE}",
    f"echo a > /tmp/x; echo b >{TEST_FILE}",
])
def test_redirect_to_a_protected_file_is_refused_in_green(cmd):
    assert not rules.check_bash("green", cmd).ok


@pytest.mark.parametrize("cmd", [
    f"echo x >{TEST_FILE}",
    f"echo a >/tmp/x && echo b > {TEST_FILE}",
])
def test_redirect_to_a_test_file_is_fine_in_red(cmd):
    assert rules.check_bash("red", cmd).ok


def test_harmless_redirects_stay_allowed():
    assert rules.check_bash("green", "make 2>&1 | tail").ok
    assert rules.check_bash("green", "echo a >/tmp/x").ok
    assert rules.check_bash("green", "ls 2>/dev/null").ok
