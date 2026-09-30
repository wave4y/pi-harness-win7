# -*- coding: utf-8 -*-
"""Fetch a bounded JSON response with GET and save it without overwriting files."""
import argparse
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-bytes", type=int, default=2 * 1024 * 1024)
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        import requests
        url = urlsplit(args.url)
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
            raise ValueError("Use an HTTP(S) URL without embedded credentials")
        if args.max_bytes < 1:
            raise ValueError("--max-bytes must be positive")
        output = Path(args.output).expanduser().resolve()
        if output.exists():
            raise FileExistsError("Output already exists")
        with requests.get(args.url, timeout=(5, 30), stream=True, allow_redirects=False,
                          headers={"Accept": "application/json"}) as response:
            response.raise_for_status()
            if 300 <= response.status_code < 400:
                raise ValueError("Redirect received; inspect and explicitly choose the destination URL")
            chunks = []
            size = 0
            for chunk in response.iter_content(chunk_size=65536):
                size += len(chunk)
                if size > args.max_bytes:
                    raise ValueError("Response exceeds --max-bytes")
                chunks.append(chunk)
            payload = json.loads(b"".join(chunks).decode("utf-8-sig"))
            status = response.status_code
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        with output.open("r", encoding="utf-8") as handle:
            if json.load(handle) != payload:
                raise ValueError("Saved JSON did not round-trip")
        print(json.dumps({"ok": True, "output": str(output), "status": status,
                          "responseBytes": size, "verified": True}, ensure_ascii=False))
        return 0
    except Exception as error:
        # Requests exceptions may contain URLs with secret query values; do not print them.
        if type(error).__module__.startswith("requests."):
            message = type(error).__name__
        else:
            message = str(error) if isinstance(error, (ValueError, FileExistsError)) else type(error).__name__
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
