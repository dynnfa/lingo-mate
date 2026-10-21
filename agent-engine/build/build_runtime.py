"""Build on the target OS/CPU. Never run as part of application startup."""

import json
import os
import platform
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARCH = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x64", "amd64": "x64"}[
    platform.machine().lower()
]
TARGET = f"{sys.platform}-{ARCH}"
subprocess.run(
    [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        "lingo-agent",
        "--distpath",
        str(ROOT / "dist" / TARGET),
        "--workpath",
        str(ROOT / "build" / "work" / TARGET),
        "--specpath",
        str(ROOT / "build" / "work"),
        "--paths",
        str(ROOT / "src"),
        "--add-data",
        f"{ROOT / 'src/lingo_agent/protocol/schema.json'}:lingo_agent/protocol",
        "--collect-submodules",
        "langgraph",
        "--copy-metadata",
        "langgraph",
        "--copy-metadata",
        "langchain-core",
        str(ROOT / "build" / "entry.py"),
    ],
    check=True,
    env={**os.environ, "PYINSTALLER_CONFIG_DIR": str(ROOT / "build" / "work" / "cache")},
)
package = json.loads((ROOT.parent / "package.json").read_text())
schema = json.loads((ROOT / "src/lingo_agent/protocol/schema.json").read_text())
manifest = {
    "protocolVersion": schema["oneOf"][0]["properties"]["v"]["const"],
    "appVersion": package["version"],
    "platform": sys.platform,
    "arch": ARCH,
}
directory = ROOT / "dist" / TARGET / "lingo-agent"
(directory / "runtime.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Runtime ready: {directory}")

# Tar preserves executable modes and framework/library symlinks across artifact upload.
archive = ROOT / "dist" / f"lingo-agent-{TARGET}.tar.gz"
with tarfile.open(archive, "w:gz") as bundle:
    bundle.add(directory, arcname="lingo-agent")
print(f"Archive ready: {archive}")
