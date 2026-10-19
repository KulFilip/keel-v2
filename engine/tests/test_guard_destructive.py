"""The guard refuses commands that delete data or history in every phase (rules.DESTRUCTIVE)."""
import pytest

from keel_engine import rules
from keel_engine.runtime import init_actions

BAD = ["rm -rf /", "rm -r build", "rm -f -r ~/x", "git reset --hard HEAD~1", "git clean -fdx", "docker volume rm data",
       "docker compose down -v", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda", "psql -c 'DROP TABLE users'", "sudo ls"]
OK = ["rm -f tmp.txt", "git status", "docker compose up -d", "npm test", "git reset HEAD file.txt"]


@pytest.mark.parametrize("phase", ["setup", "none", "green", "spec", "red"])
@pytest.mark.parametrize("cmd", BAD)
def test_every_phase_refuses_a_destructive_command(phase, cmd):
    v = rules.check_bash(phase, cmd)
    assert not v.ok and "deletes data or history" in v.reason, (phase, cmd)


@pytest.mark.parametrize("cmd", OK)
def test_ordinary_commands_are_not_destructive(cmd):
    assert rules.destructive(cmd) is None


def test_inits_fix_uses_the_guards_list_and_its_own_extras():
    assert init_actions._destructive("rm -rf /") and init_actions._destructive("git push origin main")
    assert init_actions._destructive("rm -f data.db") and not init_actions._destructive("docker compose up -d")
