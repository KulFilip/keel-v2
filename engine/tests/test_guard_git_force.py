"""The "never off" force-push and reset --hard rules match the flag wherever it stands, not as one fixed string."""

from __future__ import annotations

import pytest

from keel_engine import rules

FORCED_PUSHES = [
    "git push --force",
    "git push origin main --force",
    "git push -f origin main",
    "git push origin main -f",
    "git push -uf origin main",
    "git push origin +main",
    "git push origin +HEAD:main",
    "git push --force-with-lease",
    "git push origin main --force-with-lease=main:abc",
    "git push --force-if-includes origin main",
    "git -C sub push origin main --force",
    "git -c core.x=y push -f",
    "cd x && git push origin main --force",
    "git status; git push origin main -f",
    "ls | git push -f",
    "bash -c 'git push origin main --force'",
    "echo $(git push origin main --force)",
]

SAFE_PUSHES = [
    "git push",
    "git push origin main",
    "git push -u origin feature",
    "git push --set-upstream origin feature",
    "git push origin feature:feature",
    "git pull --ff-only",
    "git fetch --force",
    "git log --oneline",
]


@pytest.mark.parametrize("cmd", FORCED_PUSHES)
@pytest.mark.parametrize("phase", ["none", "green"])
def test_forced_push_is_refused_wherever_the_flag_stands(cmd, phase):
    assert not rules.check_bash(phase, cmd).ok


@pytest.mark.parametrize("cmd", SAFE_PUSHES)
def test_normal_git_commands_stay_allowed(cmd):
    assert rules.check_bash("none", cmd).ok


@pytest.mark.parametrize("cmd", [
    "git reset origin/main --hard",
    "git reset --hard HEAD~1",
    "git -C x reset --hard",
    "cd x && git reset HEAD~1 --hard",
])
def test_reset_hard_is_refused_in_a_flow_wherever_the_flag_stands(cmd):
    assert not rules.check_bash("green", cmd).ok


def test_reset_without_hard_and_reset_hard_outside_a_flow_are_not_this_rules_business():
    assert rules.check_bash("green", "git reset HEAD~1").ok
    assert rules.check_bash("green", "git reset --soft HEAD~1").ok
    assert rules.check_bash("none", "git reset origin/main --hard").ok   # asked by the permission card instead
