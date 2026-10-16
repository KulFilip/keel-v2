"""Write engine/tests/fixtures/flowmap/<id>.json: one per content/workflows/*.yaml (keys in the workflow's own order:
a gate's first choice is its default route).

Each holds the workflow's steps as the engine expands them (includes in place) and what the flow map makes of them:
the main path, the sections, the orphans and the side paths. engine/tests/test_diagrams.py checks keel_engine.diagrams
(the ASCII renderer) against them, web/src/test/flowmapFixtures.test.ts checks the web's buildFlowMap: the two cannot
drift apart. Run it again after a workflow changes:

    cd engine && uv run python ../scripts/flowmap_fixtures.py
"""

import json
import sys
from pathlib import Path

from keel_engine import diagrams
from keel_engine.workflows.templates import templates

OUT = Path(__file__).resolve().parent.parent / "engine" / "tests" / "fixtures" / "flowmap"


def fixtures() -> dict[str, dict]:
    out = {}
    for t in templates():
        steps = [s.model_dump(exclude_none=True) for s in t.steps]
        out[t.id] = {"workflow": t.id, "name": t.name, "steps": steps,
                     "expect": diagrams.summary(diagrams.build_flow_map(diagrams._steps_of({"steps": steps})))}
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for wid, fx in fixtures().items():
        (OUT / f"{wid}.json").write_text(json.dumps(fx, indent=1) + "\n")
        print(OUT / f"{wid}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
