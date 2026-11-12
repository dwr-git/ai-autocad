#!/usr/bin/env python3
"""Russian names for the assistant's command search.

Reads the Russian interface catalog AI Чертежи is built with (crates/ui-egui/src/i18n/ru.tsv: rows
`context<TAB>English<TAB>Русский`, `#` comments) and writes studio/ru-labels.json:

    {"text": {"Line": "Отрезок", ...}}

The assistant panel uses it to show and search commands (their labels and menu-path segments) in
Russian. Only rows without a context are taken (plural rows are skipped). Run by
studio/build/package.sh.
"""

import json
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    src = root / "crates" / "ui-egui" / "src" / "i18n" / "ru.tsv"
    dst = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("ru-labels.json")
    text: dict[str, str] = {}
    if not src.is_file():
        print(f"warning: {src} not found; command names stay English", file=sys.stderr)
    else:
        for line in src.read_text(encoding="utf-8").splitlines():
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 3 or parts[0] != "":
                continue
            en, ru = parts[1], parts[2]
            if en and ru.strip():
                text[en] = ru
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps({"text": text}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{dst}: {len(text)} labels")
    return 0


if __name__ == "__main__":
    sys.exit(main())
