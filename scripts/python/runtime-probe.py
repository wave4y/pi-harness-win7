"""Read-only probe for the fixed portable runtime. JSON stdout; no package installation."""
import hashlib
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import ssl
import struct
import sys

sys.dont_write_bytecode = True


def main():
    root = Path(__file__).resolve().parent
    report = {
        "schemaVersion": 1,
        "ok": False,
        "python": {
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
            "executable": sys.executable,
            "bits": struct.calcsize("P") * 8,
            "platform": platform.platform(),
            "sslVersion": ssl.OPENSSL_VERSION,
            "isolated": bool(sys.flags.isolated),
            "utf8Mode": bool(sys.flags.utf8_mode),
        },
        "modules": [],
        "checks": [],
        "win7": {"tested": False, "status": "pending", "note": "This probe reports this host only; it does not certify Windows 7 compatibility."},
    }
    def check(name, ok, details=None):
        report["checks"].append({"name": name, "ok": bool(ok), "details": details})
    try:
        manifest = json.loads((root / "runtime-manifest.json").read_text(encoding="utf-8"))
        check("interpreter-version", platform.python_version() == manifest["python"]["version"], platform.python_version())
        check("interpreter-x64", report["python"]["bits"] == 64)
        check("isolated-utf8", bool(sys.flags.isolated) and bool(sys.flags.utf8_mode))
        check("no-runtime-pip", importlib.util.find_spec("pip") is None)
        paths = [Path(value).resolve() for value in sys.path if value]
        check("isolated-module-paths", all(value == root or root in value.parents for value in paths), [str(value) for value in paths])
        check("interpreter-hash", hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest() == manifest["python"]["sha256"])
        for package in manifest["packages"]:
            module = {"name": package["imports"][0], "distribution": package["name"], "version": None, "ok": False}
            try:
                for name in package["imports"]:
                    importlib.import_module(name)
                module["version"] = importlib.metadata.version(package["name"])
                module["ok"] = module["version"] == package["version"]
                if not module["ok"]:
                    module["error"] = "Expected version " + package["version"]
            except Exception as error:
                module["error"] = type(error).__name__ + ": " + str(error)
            report["modules"].append(module)
        for name in ["_ssl", "_hashlib", "_ctypes", "_sqlite3", "zlib"]:
            try:
                importlib.import_module(name)
                check("stdlib-" + name, True)
            except Exception as error:
                check("stdlib-" + name, False, type(error).__name__ + ": " + str(error))
        report["ok"] = bool(report["modules"]) and all(item["ok"] for item in report["modules"]) and all(item["ok"] for item in report["checks"])
    except Exception as error:
        report["checks"].append({"name": "runtime-manifest", "ok": False, "error": type(error).__name__ + ": " + str(error)})
    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
