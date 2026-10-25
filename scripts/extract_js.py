#!/usr/bin/env python3
"""Extract embedded JS bundles and interesting strings from opencode.exe.

The opencode CLI is a Bun-compiled Go binary; its TUI/API client logic ships
as embedded JavaScript. This extractor pulls maximal printable-ASCII runs and
gzip members, then keeps the ones that look like application JS.
"""
import gzip
import io
import os
import re
import zlib

SRC = r"C:/Users/20655/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe"
OUT = r"C:/workspace/keyless-llm/raw"
os.makedirs(OUT, exist_ok=True)

CHUNK = 8 * 1024 * 1024
MIN_RUN = 3000  # bytes of printable run worth dumping
JS_HINTS = (b"function", b"=>", b"fetch(", b"opencode.ai", b"async ", b"prototype")

# printable ASCII (tab excluded; keep \n\r for JS)
PRINTABLE = bytes(range(0x20, 0x7F)) + b"\n\r\t"


def is_printable(b):
    return all(c in PRINTABLE for c in b)


def extract_runs(path):
    """Yield (offset, length, data) for maximal printable runs >= MIN_RUN."""
    runs = []
    tail = b""
    tail_off = 0
    base = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(CHUNK)
            if not chunk:
                break
            buf = tail + chunk
            start = None
            i = 0
            n = len(buf)
            while i < n:
                c = buf[i]
                if c in PRINTABLE:
                    if start is None:
                        start = i
                else:
                    if start is not None:
                        ln = i - start
                        if ln >= MIN_RUN:
                            runs.append((base + tail_off + start - len(tail), ln, buf[start:i]))
                        start = None
                i += 1
            # carry over the trailing printable run
            if start is not None:
                tail = buf[start:]
                tail_off = base + start
            else:
                tail = b""
                tail_off = 0
            base += len(chunk)
    if len(tail) >= MIN_RUN:
        runs.append((tail_off, len(tail), tail))
    return runs


def looks_like_js(data):
    score = sum(1 for h in JS_HINTS if h in data)
    return score >= 2


def main():
    print(f"scanning {SRC} ...")
    runs = extract_runs(SRC)
    print(f"printable runs >= {MIN_RUN}B: {len(runs)}")

    kept = []
    for off, ln, data in runs:
        if looks_like_js(data):
            kept.append((off, ln, data))
    print(f"JS-looking runs: {len(kept)}")

    manifest = []
    for idx, (off, ln, data) in enumerate(kept):
        name = f"jsrun_{idx:03d}_off{off:012x}_{ln // 1024}kb.js"
        p = os.path.join(OUT, name)
        with open(p, "wb") as f:
            f.write(data)
        manifest.append({"file": name, "offset": off, "length": ln})
        print(f"  {name}")

    # gzip members that decompress to JS-looking content
    gz_kept = 0
    with open(SRC, "rb") as f:
        blob = f.read()
    for m in re.finditer(rb"\x1f\x8b\x08", blob):
        s = m.start()
        try:
            d = gzip.GzipFile(fileobj=io.BytesIO(blob[s:s + 64 * 1024 * 1024])).read()
        except Exception:
            continue
        if len(d) >= MIN_RUN and looks_like_js(d):
            gz_kept += 1
            name = f"gzrun_{gz_kept:03d}_off{s:012x}_{len(d) // 1024}kb.js"
            with open(os.path.join(OUT, name), "wb") as f:
                f.write(d)
            manifest.append({"file": name, "offset": s, "length": len(d), "gzip": True})
            print(f"  {name} (gzip)")

    with open(os.path.join(OUT, "extract-manifest.json"), "w", encoding="utf-8") as f:
        import json
        json.dump(manifest, f, indent=1)
    print(f"done: {len(manifest)} artifacts -> {OUT}")


if __name__ == "__main__":
    main()
