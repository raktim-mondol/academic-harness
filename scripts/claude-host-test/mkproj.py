"""Build the unit-test fixture project and install the Claude Code hooks into it. Usage: mkproj.py <dir>"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import ENGINE, install_shim

sys.path.insert(0, str(ENGINE))
sys.path.insert(0, str(ENGINE / "tests"))
from conftest import write_anchored_project  # noqa: E402
from ah.hooks import hooks_config  # noqa: E402

root = Path(sys.argv[1]).resolve()
write_anchored_project(root)
(root / ".claude").mkdir(exist_ok=True)
(root / ".claude" / "settings.json").write_text(json.dumps(hooks_config(str(install_shim())), indent=1))
print("project ready:", root)
