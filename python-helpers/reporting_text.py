#!/usr/bin/env python3
"""Return a manuscript's plain text as JSON.

Reads {"path": "..."} on stdin and prints {"text": "...", "format": "docx"}.
Used by reporting_check for Word documents, whose text lives inside a zip
container that the JavaScript tool cannot read directly.
"""
import json
import sys

from document_text import read_source


def main():
    try:
        request = json.load(sys.stdin)
        path, text = read_source(request)
        print(json.dumps({"path": path, "text": text}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
