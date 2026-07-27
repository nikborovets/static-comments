"""Portable text-review comments service (FastAPI + SQLite).

Drop this whole `static-comments/` folder into any project. It stores
text-anchored review comments + threaded replies, serves the front-end widget
at /widget.js, and exports everything to Markdown. No auth — intended for a
private / VPN-only network. See README.md for wiring it into a page.

Routes are at the service root (/comments, /widget.js, ...) so the same widget
works both behind a reverse proxy and via a directly published host:port — the
widget derives its API base from its own <script src>.
"""
import os
import sqlite3
import datetime
from contextlib import contextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, FileResponse, JSONResponse
from pydantic import BaseModel, Field

DB_PATH = os.environ.get("COMMENTS_DB", "/data/comments.db")
EXPORT_TITLE = os.environ.get("COMMENTS_TITLE", "Комментарии ревью")
SOURCE_FILE = os.environ.get("COMMENTS_SOURCE_FILE", "index.html")
WIDGET_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "widget.js")
# External path prefix this service is proxied under (e.g. "/api"; nginx strips
# it). Lets the built-in Swagger UI reference the spec at the right URL. Empty
# for a standalone deployment. Swagger UI assets load from a CDN, which is fine
# as long as the browser has outbound internet.
#
# To turn the API docs OFF entirely, add docs_url=None, redoc_url=None,
# openapi_url=None to the FastAPI(...) call below.
ROOT_PATH = os.environ.get("COMMENTS_ROOT_PATH", "").rstrip("/")

app = FastAPI(title="Comments service", openapi_url="/openapi.json", root_path=ROOT_PATH)
# app = FastAPI(title="Comments service", docs_url=None, redoc_url=None, openapi_url=None, root_path=ROOT_PATH)

# CORS is OFF by default: when the widget is served same-origin (behind a
# reverse proxy at /api/), no CORS is needed, and leaving it open would let any
# page a reviewer visits POST/DELETE comments cross-site. Enable it ONLY for a
# standalone / cross-origin deployment by setting COMMENTS_CORS_ORIGINS to a
# comma-separated allow-list (or "*" to allow any origin — trusted networks only).
_cors = os.environ.get("COMMENTS_CORS_ORIGINS", "").strip()
if _cors:
    _origins = ["*"] if _cors == "*" else [o.strip() for o in _cors.split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    with db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS comments (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at    TEXT    NOT NULL,
                author        TEXT    NOT NULL,
                section_id    TEXT,
                section_title TEXT,
                quote         TEXT    NOT NULL,
                prefix        TEXT,
                suffix        TEXT,
                comment       TEXT    NOT NULL,
                resolved      INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS replies (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                comment_id INTEGER NOT NULL,
                created_at TEXT    NOT NULL,
                author     TEXT    NOT NULL,
                body       TEXT    NOT NULL,
                FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
            )
            """
        )
        # block-anchor columns (added over time — migrate in place)
        existing = {r["name"] for r in conn.execute("PRAGMA table_info(comments)")}
        for name, ddl in [
            ("block_id", "TEXT"),
            ("block_line", "INTEGER"),
            ("block_index", "INTEGER"),
            ("start_offset", "INTEGER"),
            ("end_offset", "INTEGER"),
        ]:
            if name not in existing:
                conn.execute(f"ALTER TABLE comments ADD COLUMN {name} {ddl}")


init_db()


class CommentIn(BaseModel):
    author: str = Field(min_length=1, max_length=120)
    quote: str = Field(min_length=1, max_length=5000)
    comment: str = Field(min_length=1, max_length=10000)
    prefix: str = ""
    suffix: str = ""
    sectionId: str = ""
    sectionTitle: str = ""
    # blockId is used verbatim in a CSS attribute selector on the client, so
    # restrict it to a safe charset (no quotes/brackets/backslashes) server-side.
    blockId: Optional[str] = Field(default=None, max_length=200, pattern=r"^[\w:.#\- ]+$")
    blockLine: Optional[int] = None
    blockIndex: Optional[int] = None
    startOffset: Optional[int] = None
    endOffset: Optional[int] = None


class ResolveIn(BaseModel):
    resolved: bool = True


class ReplyIn(BaseModel):
    author: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=10000)


def reply_to_dict(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "comment_id": r["comment_id"],
        "created_at": r["created_at"],
        "author": r["author"],
        "body": r["body"],
    }


def _get(r: sqlite3.Row, key):
    try:
        return r[key]
    except (IndexError, KeyError):
        return None


def row_to_dict(r: sqlite3.Row, replies=None) -> dict:
    return {
        "id": r["id"],
        "created_at": r["created_at"],
        "author": r["author"],
        "sectionId": r["section_id"],
        "sectionTitle": r["section_title"],
        "quote": r["quote"],
        "prefix": r["prefix"],
        "suffix": r["suffix"],
        "comment": r["comment"],
        "resolved": bool(r["resolved"]),
        "blockId": _get(r, "block_id"),
        "blockLine": _get(r, "block_line"),
        "blockIndex": _get(r, "block_index"),
        "startOffset": _get(r, "start_offset"),
        "endOffset": _get(r, "end_offset"),
        "replies": replies if replies is not None else [],
    }


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/widget.js")
def widget():
    # no-store so a rebuilt widget is picked up without a hard refresh
    return FileResponse(
        WIDGET_PATH,
        media_type="application/javascript",
        headers={"Cache-Control": "no-store"},
    )


def fetch_comments(resolved: Optional[bool] = None) -> list:
    query = "SELECT * FROM comments"
    params: list = []
    if resolved is not None:
        query += " WHERE resolved = ?"
        params.append(1 if resolved else 0)
    query += " ORDER BY id ASC"
    with db() as conn:
        rows = conn.execute(query, params).fetchall()
        reply_rows = conn.execute("SELECT * FROM replies ORDER BY id ASC").fetchall()
    by_comment: dict = {}
    for rr in reply_rows:
        by_comment.setdefault(rr["comment_id"], []).append(reply_to_dict(rr))
    return [row_to_dict(r, by_comment.get(r["id"], [])) for r in rows]


@app.get("/comments")
def list_comments(resolved: Optional[bool] = None):
    return fetch_comments(resolved)


@app.post("/comments", status_code=201)
def create_comment(payload: CommentIn):
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with db() as conn:
        cur = conn.execute(
            """
            INSERT INTO comments
                (created_at, author, section_id, section_title, quote, prefix, suffix, comment,
                 resolved, block_id, block_line, block_index, start_offset, end_offset)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
            """,
            (
                now,
                payload.author.strip(),
                payload.sectionId,
                payload.sectionTitle,
                payload.quote,
                payload.prefix,
                payload.suffix,
                payload.comment.strip(),
                payload.blockId,
                payload.blockLine,
                payload.blockIndex,
                payload.startOffset,
                payload.endOffset,
            ),
        )
        row = conn.execute("SELECT * FROM comments WHERE id = ?", (cur.lastrowid,)).fetchone()
    return row_to_dict(row)


@app.patch("/comments/{comment_id}")
def resolve_comment(comment_id: int, payload: ResolveIn):
    with db() as conn:
        cur = conn.execute(
            "UPDATE comments SET resolved = ? WHERE id = ?",
            (1 if payload.resolved else 0, comment_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="comment not found")
        row = conn.execute("SELECT * FROM comments WHERE id = ?", (comment_id,)).fetchone()
    return row_to_dict(row)


@app.delete("/comments/{comment_id}", status_code=204)
def delete_comment(comment_id: int):
    with db() as conn:
        conn.execute("DELETE FROM replies WHERE comment_id = ?", (comment_id,))
        cur = conn.execute("DELETE FROM comments WHERE id = ?", (comment_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="comment not found")
    return None


@app.post("/comments/{comment_id}/replies", status_code=201)
def add_reply(comment_id: int, payload: ReplyIn):
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with db() as conn:
        exists = conn.execute("SELECT 1 FROM comments WHERE id = ?", (comment_id,)).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="comment not found")
        cur = conn.execute(
            "INSERT INTO replies (comment_id, created_at, author, body) VALUES (?, ?, ?, ?)",
            (comment_id, now, payload.author.strip(), payload.body.strip()),
        )
        row = conn.execute("SELECT * FROM replies WHERE id = ?", (cur.lastrowid,)).fetchone()
    return reply_to_dict(row)


@app.delete("/replies/{reply_id}", status_code=204)
def delete_reply(reply_id: int):
    with db() as conn:
        cur = conn.execute("DELETE FROM replies WHERE id = ?", (reply_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="reply not found")
    return None


@app.get("/export.md", response_class=PlainTextResponse)
def export_markdown():
    with db() as conn:
        rows = conn.execute("SELECT * FROM comments ORDER BY section_id, id").fetchall()
        reply_rows = conn.execute("SELECT * FROM replies ORDER BY id ASC").fetchall()
    by_comment: dict = {}
    for rr in reply_rows:
        by_comment.setdefault(rr["comment_id"], []).append(reply_to_dict(rr))
    lines = ["# " + EXPORT_TITLE, ""]
    current_section = object()
    for r in rows:
        d = row_to_dict(r, by_comment.get(r["id"], []))
        section = d["sectionTitle"] or d["sectionId"] or "Без секции"
        if section != current_section:
            current_section = section
            lines.append("")
            lines.append(f"## {section}")
            lines.append("")
        box = "x" if d["resolved"] else " "
        # human locator: "блок N" + source line in the annotated file
        loc_parts = []
        if d["blockIndex"] is not None:
            loc_parts.append(f"блок {d['blockIndex']}")
        if d["blockLine"] is not None:
            loc_parts.append(f"{SOURCE_FILE}:{d['blockLine']}")
        loc = (" — " + ", ".join(loc_parts)) if loc_parts else ""
        lines.append(f"- [{box}] **{d['author']}**{loc} ({d['created_at']}):")
        lines.append(f"  > {d['quote']}")
        lines.append(f"  — {d['comment']}")
        for rep in d["replies"]:
            lines.append(f"    - ↳ **{rep['author']}**: {rep['body']}")
    lines.append("")
    return "\n".join(lines)


@app.get("/export.json")
def export_json():
    payload = {
        "title": EXPORT_TITLE,
        "source_file": SOURCE_FILE,
        "exported_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "count": None,
        "comments": fetch_comments(),
    }
    payload["count"] = len(payload["comments"])
    return JSONResponse(
        payload,
        headers={"Content-Disposition": 'attachment; filename="comments.json"'},
    )
