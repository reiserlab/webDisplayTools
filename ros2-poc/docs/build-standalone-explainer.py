#!/usr/bin/env python3
"""Build plan-b-explainer.standalone.html: one self-contained file (complete HTML document,
images inlined as data URIs) from plan-b-explainer.html, which is authored as a page fragment
for the claude.ai artifact and for this folder. Run after editing the explainer:

    python3 ros2-poc/docs/build-standalone-explainer.py
"""
import base64, mimetypes, re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "plan-b-explainer.html"
OUT = HERE / "plan-b-explainer.standalone.html"

body = SRC.read_text(encoding="utf-8")


def inline(m):
    rel = m.group(1)
    p = HERE / rel
    mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    data = base64.b64encode(p.read_bytes()).decode("ascii")
    return f'src="data:{mime};base64,{data}"'


body = re.sub(r'src="(img/[^"]+)"', inline, body)
# The fragment starts with <title>, <meta description>, the fonts <link> and <style>: move those
# into <head>, the rest into <body>.
head_end = body.index("</style>") + len("</style>")
head, rest = body[:head_end], body[head_end:]
doc = (
    "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    + head.strip() + "\n</head>\n<body>\n" + rest.strip() + "\n</body>\n</html>\n"
)
OUT.write_text(doc, encoding="utf-8")
print(f"{OUT.name}: {OUT.stat().st_size / 1024:.0f} kB, {body.count('data:image')} images inlined")
