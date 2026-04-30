#!/usr/bin/env python3
"""Build dist/tendermint-sim.html: a single file that runs by double-click.

Needs node/npx (for esbuild). Source tree stays unchanged; the dev loop
(`python3 -m http.server` + index.html) keeps working.

What gets inlined:
  - css/style.css -> <style>...</style>
  - traces/index.json + every traces/*.json -> window.__INLINED_TRACE_INDEX
    and window.__INLINED_TRACES (ui.js checks these before fetching)
  - js/main.js and its dependency tree -> one esbuild IIFE script

Gotcha to remember if the stylesheet ever grows: CSS url(...) references to
local assets are not rewritten here. Only external URLs (http/https) and
data: URIs survive as-is. Today the project uses neither, so inlining is safe.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
OUT = DIST / "tendermint-sim.html"
BUNDLE = DIST / "bundle.js"

# Pinned so the build is reproducible; bump deliberately.
ESBUILD_VERSION = "0.24.0"


def run_esbuild() -> str:
    DIST.mkdir(exist_ok=True)
    cmd = [
        "npx", "--yes", f"esbuild@{ESBUILD_VERSION}",
        "js/main.js",
        "--bundle",
        "--format=iife",
        f"--outfile={BUNDLE}",
    ]
    # Run from repo root so esbuild resolves ./js/... correctly.
    result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stdout)
        sys.stderr.write(result.stderr)
        raise SystemExit(f"esbuild failed with code {result.returncode}")
    return BUNDLE.read_text()


def load_traces() -> tuple[list, dict]:
    index = json.loads((ROOT / "traces" / "index.json").read_text())
    traces = {}
    for entry in index:
        path = ROOT / "traces" / entry["file"]
        traces[entry["file"]] = json.loads(path.read_text())
    return index, traces


def build() -> None:
    bundle_js = run_esbuild()
    css = (ROOT / "css" / "style.css").read_text()
    index, traces = load_traces()
    html = (ROOT / "index.html").read_text()

    # Swap the external stylesheet link for an inline <style> block.
    html = html.replace(
        '<link rel="stylesheet" href="css/style.css">',
        f"<style>\n{css}\n</style>",
    )

    # Swap the module bootstrap for two inline scripts: trace data then bundle.
    # Use </script> escape so nested </script> sequences in the bundle don't
    # terminate the outer script early.
    def safe(s: str) -> str:
        return s.replace("</script>", "<\\/script>")

    inline = (
        "<script>\n"
        f"window.__INLINED_TRACE_INDEX = {safe(json.dumps(index))};\n"
        f"window.__INLINED_TRACES = {safe(json.dumps(traces))};\n"
        "</script>\n"
        f"<script>\n{safe(bundle_js)}\n</script>"
    )
    html = html.replace('<script type="module" src="js/main.js"></script>', inline)

    OUT.write_text(html)
    # Bundle.js intermediate is not needed after inlining.
    BUNDLE.unlink(missing_ok=True)
    size_kb = OUT.stat().st_size / 1024
    print(f"Wrote {OUT.relative_to(ROOT)} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    if shutil.which("npx") is None:
        raise SystemExit("npx not found on PATH; install node (brew install node)")
    build()
