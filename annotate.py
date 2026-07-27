#!/usr/bin/env python3
"""Annotate commentable blocks in a static HTML page for the review widget.

For every text-bearing block element (p, li, blockquote, td, th, dd,
figcaption) this injects two attributes:

    data-cmt-id="<section>:<n>"   stable per-build block id (section + index)
    data-cmt-line="<lineno>"      1-based line of the tag in the SOURCE file

The insertion is done by (line, column) reported by the stdlib HTML parser, so
the rest of the file is preserved byte-for-byte — no reserialization. This lets
comments.js anchor to a specific block (not a page-wide text search) and lets
the Markdown export point back at index.html:<line>.

Usage:  python annotate.py index.html > index.annotated.html
"""
import sys
from html.parser import HTMLParser

BLOCK_TAGS = {"p", "li", "blockquote", "td", "th", "dd", "figcaption"}


class Annotator(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.section_stack = []
        self.open_stack = []   # target blocks currently open
        self.records = []      # every target block, in document order

    @property
    def section(self):
        return self.section_stack[-1] if self.section_stack else "doc"

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if tag == "section":
            self.section_stack.append(d.get("id") or self.section)
        if tag in BLOCK_TAGS:
            line, col = self.getpos()
            rec = {"line": line, "col": col, "tag": tag,
                   "section": self.section, "text": ""}
            self.open_stack.append(rec)
            self.records.append(rec)

    def handle_endtag(self, tag):
        if tag == "section" and self.section_stack:
            self.section_stack.pop()
        if tag in BLOCK_TAGS:
            for i in range(len(self.open_stack) - 1, -1, -1):
                if self.open_stack[i]["tag"] == tag:
                    self.open_stack.pop(i)
                    break

    def _mark_text(self, data):
        if data and data.strip() and self.open_stack:
            self.open_stack[-1]["text"] += data

    def handle_data(self, data):
        self._mark_text(data)

    def handle_entityref(self, name):
        self._mark_text("&" + name)

    def handle_charref(self, name):
        self._mark_text("#" + name)


def annotate(html: str) -> str:
    parser = Annotator()
    parser.feed(html)
    parser.close()

    # keep only text-bearing blocks, number them per-section in document order
    counts = {}
    inserts = {}  # line -> list of (col, attr_string)
    for rec in parser.records:
        if not rec["text"].strip():
            continue
        sec = rec["section"]
        counts[sec] = counts.get(sec, 0) + 1
        idx = counts[sec]
        block_id = f"{sec}:{idx}"
        attr = f' data-cmt-id="{block_id}" data-cmt-line="{rec["line"]}"'
        # column just after "<tag"
        pos = rec["col"] + 1 + len(rec["tag"])
        inserts.setdefault(rec["line"], []).append((pos, attr, rec["tag"]))

    lines = html.splitlines(keepends=True)
    for lineno, items in inserts.items():
        if lineno < 1 or lineno > len(lines):
            continue
        line = lines[lineno - 1]
        # insert right-to-left so earlier columns stay valid
        for pos, attr, tag in sorted(items, key=lambda x: x[0], reverse=True):
            # safety: the tag really starts where the parser said
            if line[pos - 1 - len(tag):pos].lower() != "<" + tag:
                continue
            line = line[:pos] + attr + line[pos:]
        lines[lineno - 1] = line
    return "".join(lines)


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: annotate.py <input.html>\n")
        sys.exit(2)
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        html = f.read()
    sys.stdout.write(annotate(html))


if __name__ == "__main__":
    main()
