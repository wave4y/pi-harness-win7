# -*- coding: utf-8 -*-
"""Create a PNG preview, or fit an input image into a bounded size without upscaling."""
import argparse
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input")
    parser.add_argument("--output", required=True, help="New PNG path")
    parser.add_argument("--max-size", type=int, default=640)
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        from PIL import Image, ImageDraw, ImageOps
        if args.max_size < 1:
            raise ValueError("--max-size must be positive")
        if args.input:
            with Image.open(str(Path(args.input).expanduser())) as source:
                source.load()
                picture = ImageOps.exif_transpose(source).convert("RGBA")
        else:
            picture = Image.new("RGBA", (800, 480), (239, 244, 250, 255))
            drawing = ImageDraw.Draw(picture)
            drawing.rounded_rectangle((80, 80, 720, 400), radius=32, fill=(50, 100, 180, 255))
            drawing.ellipse((330, 170, 470, 310), fill=(255, 220, 130, 255))
        try:
            picture.thumbnail((args.max_size, args.max_size), Image.Resampling.LANCZOS)
            expected_size = picture.size
            output = Path(args.output).expanduser().resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("xb") as handle:
                picture.save(handle, format="PNG")
        finally:
            picture.close()
        with Image.open(str(output)) as reopened:
            reopened.load()
            if reopened.size != expected_size or reopened.format != "PNG":
                raise ValueError("Saved PNG dimensions or format mismatch")
        print(json.dumps({"ok": True, "output": str(output), "size": list(expected_size),
                          "format": "PNG", "verified": True}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": "{}: {}".format(type(error).__name__, error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
