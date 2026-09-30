# -*- coding: utf-8 -*-
"""Calculate amounts from a UTF-8 CSV, or generate a small example without an input."""
import argparse
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="CSV with columns 项目,数量,单价")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        import numpy as np
        import pandas as pd
        if args.input:
            data = pd.read_csv(str(Path(args.input).expanduser()), encoding="utf-8-sig",
                               dtype={"项目": str}, keep_default_na=False)
        else:
            data = pd.DataFrame({"项目": ["文具", "纸张"], "数量": [2, 3], "单价": [12.5, 8.0]})
        for column in ["项目", "数量", "单价"]:
            if column not in data.columns:
                raise ValueError("Missing CSV column: " + column)
        for column in ["数量", "单价"]:
            data[column] = pd.to_numeric(data[column], errors="raise")
            if not np.isfinite(data[column].to_numpy(dtype=float)).all():
                raise ValueError("Missing or non-finite numeric value in " + column)
        data["金额"] = np.round(data["数量"].to_numpy() * data["单价"].to_numpy(), 2)
        output = Path(args.output).expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        data.to_csv(str(output), index=False, encoding="utf-8-sig", mode="x")
        reopened = pd.read_csv(str(output), encoding="utf-8-sig", dtype={"项目": str}, keep_default_na=False)
        if len(reopened) != len(data) or list(reopened.columns) != list(data.columns):
            raise ValueError("Saved CSV shape mismatch")
        if reopened["项目"].tolist() != data["项目"].tolist() or not np.allclose(reopened["金额"], data["金额"]):
            raise ValueError("Saved CSV values mismatch")
        print(json.dumps({"ok": True, "output": str(output), "rows": len(reopened),
                          "columns": list(reopened.columns), "total": float(reopened["金额"].sum()),
                          "verified": True}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": "{}: {}".format(type(error).__name__, error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
