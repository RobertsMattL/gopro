#!/usr/bin/env python3
"""GoPro toolkit: export files from an SD card and serve a media gallery."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

VIDEO_EXTS = {".mp4", ".360"}
AUX_EXTS = {".lrv", ".thm", ".wav"}
# Media the `serve` command lists in the gallery, split by kind so each can be
# routed to the right player/viewer on the frontend.
GALLERY_VIDEO_EXTS = {".mp4", ".mov", ".m4v"}
GALLERY_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff"}
GALLERY_EXTS = GALLERY_VIDEO_EXTS | GALLERY_IMAGE_EXTS
THUMB_DIR_NAME = ".thumbnails"
CATEGORIES_DB_NAME = "categories.db"
MAX_POST_BYTES = 1 << 16  # 64 KiB is plenty for our JSON bodies


# ---------------------------------------------------------------------------
# Shared utilities
# ---------------------------------------------------------------------------

def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


def find_files(src: Path, exts: set[str]) -> list[Path]:
    # Skip macOS AppleDouble sidecars ("._NAME"): tiny resource-fork files the
    # Finder scatters onto exFAT/FAT volumes. They share the real file's
    # extension but aren't decodable media, and should never be copied either.
    return sorted(
        p for p in src.rglob("*")
        if p.is_file() and p.suffix.lower() in exts and not p.name.startswith("._")
    )


def friendly_ctime(p: Path) -> str:
    st = p.stat()
    ts = getattr(st, "st_birthtime", st.st_mtime)
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def find_aux_companions(video: Path) -> list[Path]:
    """Return existing aux files (.lrv/.thm/.wav) that belong to this video.

    Matches two GoPro naming conventions:
      - same stem, aux extension (HERO5 and earlier, plus .THM/.WAV on all models)
      - GX-prefix MP4 paired with a GL-prefix .LRV (HERO6+)
    Case-insensitive on both stem and extension.
    """
    parent = video.parent
    stem = video.stem
    candidates: list[Path] = []
    stems = {stem}
    # HERO6+: GX010123.MP4 has its low-res preview saved as GL010123.LRV.
    if len(stem) >= 2 and stem[:2].upper() == "GX":
        stems.add("GL" + stem[2:])
    try:
        entries = list(parent.iterdir())
    except OSError:
        return []
    for entry in entries:
        if not entry.is_file() or entry == video:
            continue
        if entry.suffix.lower() not in AUX_EXTS:
            continue
        if entry.stem.upper() in {s.upper() for s in stems}:
            candidates.append(entry)
    return candidates


# ---------------------------------------------------------------------------
# Export subcommand (original behavior)
# ---------------------------------------------------------------------------

def unique_dest(dest_dir: Path, name: str) -> Path:
    candidate = dest_dir / name
    if not candidate.exists():
        return candidate
    stem, suffix = Path(name).stem, Path(name).suffix
    i = 1
    while True:
        candidate = dest_dir / f"{stem}_{i}{suffix}"
        if not candidate.exists():
            return candidate
        i += 1


def copy_one(src: Path, dest_dir: Path) -> tuple[Path, int, bool]:
    """Copy src into dest_dir. Skip if a same-size file already exists. Returns (dest, size, skipped)."""
    size = src.stat().st_size
    existing = dest_dir / src.name
    if existing.exists() and existing.stat().st_size == size:
        return existing, size, True
    dest = unique_dest(dest_dir, src.name)
    shutil.copy2(src, dest)
    if dest.stat().st_size != size:
        dest.unlink(missing_ok=True)
        raise IOError(f"size mismatch after copy: {src} -> {dest}")
    return dest, size, False


def confirm(prompt: str) -> bool:
    try:
        return input(f"{prompt} [y/N] ").strip().lower() in ("y", "yes")
    except EOFError:
        return False


def is_writable(directory: Path) -> bool:
    """Probe write access by actually creating and removing a temp file."""
    probe = directory / ".gopro_write_test"
    try:
        probe.touch()
        probe.unlink()
        return True
    except OSError:
        return False


READ_ONLY_HINT = (
    "Source filesystem is read-only — cannot delete files there.\n"
    "  On macOS this usually means:\n"
    "    1) The SD card has a physical write-lock tab — slide it to unlocked, or\n"
    "    2) The card was ejected uncleanly. Try: diskutil unmount /Volumes/<NAME>\n"
    "       then re-insert, or repair with: sudo fsck_exfat -d /dev/diskNsM\n"
    "  Re-run with --delete once writable, or omit --delete to keep sources."
)


def cmd_export(args: argparse.Namespace) -> int:
    src: Path = args.input.expanduser().resolve()
    dst: Path = args.output.expanduser().resolve()

    if not src.is_dir():
        print(f"error: input directory does not exist: {src}", file=sys.stderr)
        return 2
    if src == dst or dst.is_relative_to(src):
        print("error: output must not be the same as or inside input", file=sys.stderr)
        return 2

    if args.delete and not args.dry_run and not is_writable(src):
        print(f"error: {READ_ONLY_HINT}", file=sys.stderr)
        return 2

    if args.ext:
        exts = {(e if e.startswith(".") else "." + e).lower() for e in args.ext}
    else:
        exts = set(VIDEO_EXTS)
        if args.include_aux:
            exts |= AUX_EXTS

    files = find_files(src, exts)
    if not files:
        print(f"No matching files found under {src} (extensions: {', '.join(sorted(exts))})")
        return 0

    total_size = sum(f.stat().st_size for f in files)
    print(f"Found {len(files)} file(s), {human_size(total_size)} total")
    print(f"  from: {src}")
    print(f"    to: {dst}")
    if args.dry_run:
        for f in files:
            print(f"  [dry-run] {f.relative_to(src)}  ({friendly_ctime(f)}, {human_size(f.stat().st_size)})")
        return 0

    dst.mkdir(parents=True, exist_ok=True)

    copied = skipped = failed = 0
    bytes_copied = 0
    successful_sources: list[Path] = []
    for i, f in enumerate(files, 1):
        rel = f.relative_to(src)
        try:
            dest, size, was_skipped = copy_one(f, dst)
            if was_skipped:
                skipped += 1
                tag = "SKIP (exists)"
            else:
                copied += 1
                bytes_copied += size
                tag = "OK"
            print(f"  [{i}/{len(files)}] {tag}: {rel} -> {dest.name} ({friendly_ctime(f)}, {human_size(size)})")
            successful_sources.append(f)
        except Exception as e:
            failed += 1
            print(f"  [{i}/{len(files)}] FAIL: {rel}: {e}", file=sys.stderr)

    print()
    print(f"Copied {copied} file(s), {human_size(bytes_copied)}")
    if skipped:
        print(f"Skipped {skipped} (already present at destination)")
    if failed:
        print(f"Failed {failed} file(s)", file=sys.stderr)

    if args.delete:
        if failed:
            print("Refusing to delete sources because some copies failed.", file=sys.stderr)
            return 1
        if not args.yes and not confirm(f"Delete {len(successful_sources)} source file(s) from {src}?"):
            print("Delete cancelled.")
            return 0
        # Also sweep aux companions (.LRV/.THM/.WAV) for every successfully
        # copied video, even if --include-aux wasn't used — leaving them on the
        # card is the whole reason a follow-up export looks like it has work to
        # do. find_aux_companions only matches video stems, so non-video files
        # (already-deleted MP4s, unrelated files) are unaffected.
        aux_to_delete: list[Path] = []
        seen_aux: set[Path] = set()
        for f in successful_sources:
            if f.suffix.lower() not in VIDEO_EXTS:
                continue
            for aux in find_aux_companions(f):
                if aux in seen_aux:
                    continue
                seen_aux.add(aux)
                aux_to_delete.append(aux)

        deleted = 0
        delete_errors = 0
        readonly_seen = False
        for f in [*successful_sources, *aux_to_delete]:
            try:
                f.unlink()
                deleted += 1
            except FileNotFoundError:
                continue  # may have been deleted as part of the video set already
            except OSError as e:
                delete_errors += 1
                if e.errno == 30:  # EROFS
                    readonly_seen = True
                else:
                    print(f"  delete failed: {f}: {e}", file=sys.stderr)
        print(f"Deleted {deleted} source file(s)")
        if delete_errors:
            print(f"Delete failed for {delete_errors} file(s).", file=sys.stderr)
            if readonly_seen:
                print(READ_ONLY_HINT, file=sys.stderr)
            return 1

    return 1 if failed else 0


# ---------------------------------------------------------------------------
# Serve subcommand: REST API + thumbnail cache
# ---------------------------------------------------------------------------

def encode_id(relpath: str) -> str:
    return base64.urlsafe_b64encode(relpath.encode("utf-8")).decode("ascii").rstrip("=")


def decode_id(vid: str) -> str:
    pad = "=" * (-len(vid) % 4)
    return base64.urlsafe_b64decode(vid + pad).decode("utf-8")


class ThumbnailCache:
    """Generates and caches JPEG thumbnails for video files using ffmpeg.

    Cache files are keyed on a hash of the relative path + the source file's
    mtime, so a re-encoded source automatically invalidates its thumbnail.
    A per-key lock prevents two requests from launching ffmpeg in parallel
    for the same video.
    """

    def __init__(self, root: Path, cache_dir: Path, ffmpeg: str = "ffmpeg",
                 seek_seconds: float = 1.0, width: int = 480) -> None:
        self.root = root
        self.cache_dir = cache_dir
        self.ffmpeg = ffmpeg
        self.seek_seconds = seek_seconds
        self.width = width
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _lock_for(self, key: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock

    def _path_for(self, video: Path) -> Path:
        st = video.stat()
        digest = hashlib.sha1(
            f"{video.resolve()}::{int(st.st_mtime_ns)}".encode("utf-8")
        ).hexdigest()
        return self.cache_dir / f"{digest}.jpg"

    def delete_for(self, video: Path) -> bool:
        """Remove the cached thumbnail for a video. Must be called BEFORE the
        source is unlinked because the cache key depends on its mtime. Returns
        True if a thumbnail was actually removed."""
        try:
            target = self._path_for(video)
        except OSError:
            return False
        try:
            target.unlink()
            return True
        except FileNotFoundError:
            return False
        except OSError as e:
            print(f"[thumb] failed to remove {target}: {e}", file=sys.stderr)
            return False

    def get(self, video: Path, is_image: bool = False) -> Path | None:
        """Return path to a cached thumbnail, generating it if needed.

        Works for both videos and still images; pass ``is_image=True`` for the
        latter so we skip the (meaningless) seek pass. Returns None on failure
        (e.g. ffmpeg missing or the source unreadable).
        """
        target = self._path_for(video)
        if target.exists() and target.stat().st_size > 0:
            return target

        with self._lock_for(str(target)):
            if target.exists() and target.stat().st_size > 0:
                return target

            tmp = target.with_suffix(".jpg.tmp")
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
            # Videos: try a fast seek first; if that fails, retry without
            # seeking (some GoPro fragmented streams choke on -ss). Images have
            # nothing to seek, so grab the single frame directly.
            attempts = ("no-seek",) if is_image else ("seek", "no-seek")
            for attempt in attempts:
                cmd = [self.ffmpeg, "-y", "-loglevel", "error"]
                if attempt == "seek":
                    cmd += ["-ss", str(self.seek_seconds)]
                cmd += [
                    "-i", str(video),
                    "-frames:v", "1",
                    "-vf", f"scale={self.width}:-2",
                    "-q:v", "5",
                    "-f", "image2",
                    str(tmp),
                ]
                try:
                    result = subprocess.run(
                        cmd, capture_output=True, timeout=30
                    )
                except (FileNotFoundError, subprocess.TimeoutExpired) as e:
                    print(f"[thumb] {video.name}: {e}", file=sys.stderr)
                    return None
                if result.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
                    try:
                        os.replace(tmp, target)
                        return target
                    except OSError as e:
                        print(f"[thumb] rename failed: {e}", file=sys.stderr)
                        return None
                else:
                    err = result.stderr.decode("utf-8", "replace").strip()
                    if err:
                        print(f"[thumb][{attempt}] {video.name}: {err}", file=sys.stderr)
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
            return None


class TranscodeCache:
    """Generates and caches 720p H.264/AAC MP4 transcodes of source videos for
    mobile playback. Same cache-key scheme as ThumbnailCache (resolve + mtime),
    same per-key locking, but the output is a faststart-flagged MP4."""

    def __init__(self, root: Path, cache_dir: Path, ffmpeg: str = "ffmpeg",
                 height: int = 720, crf: int = 23, audio_bitrate: str = "128k",
                 timeout: int = 3600) -> None:
        self.root = root
        self.cache_dir = cache_dir
        self.ffmpeg = ffmpeg
        self.height = height
        self.crf = crf
        self.audio_bitrate = audio_bitrate
        self.timeout = timeout
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _lock_for(self, key: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock

    def _path_for(self, video: Path) -> Path:
        st = video.stat()
        digest = hashlib.sha1(
            f"{video.resolve()}::{int(st.st_mtime_ns)}::{self.height}p".encode("utf-8")
        ).hexdigest()
        return self.cache_dir / f"{digest}.{self.height}p.mp4"

    def delete_for(self, video: Path) -> bool:
        try:
            target = self._path_for(video)
        except OSError:
            return False
        try:
            target.unlink()
            return True
        except FileNotFoundError:
            return False
        except OSError as e:
            print(f"[transcode] failed to remove {target}: {e}", file=sys.stderr)
            return False

    def get(self, video: Path) -> Path | None:
        target = self._path_for(video)
        if target.exists() and target.stat().st_size > 0:
            return target

        with self._lock_for(str(target)):
            if target.exists() and target.stat().st_size > 0:
                return target

            tmp = target.with_suffix(target.suffix + ".tmp")
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
            cmd = [
                self.ffmpeg, "-y", "-nostdin", "-loglevel", "error",
                "-i", str(video),
                "-vf", f"scale=-2:{self.height}",
                "-c:v", "libx264", "-preset", "veryfast",
                "-crf", str(self.crf), "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", self.audio_bitrate, "-ac", "2",
                "-movflags", "+faststart",
                # The tmp path ends in .mp4.tmp, which ffmpeg can't auto-detect
                # — force the mp4 muxer explicitly.
                "-f", "mp4",
                str(tmp),
            ]
            try:
                result = subprocess.run(cmd, capture_output=True, timeout=self.timeout)
            except (FileNotFoundError, subprocess.TimeoutExpired) as e:
                print(f"[transcode] {video.name}: {e}", file=sys.stderr)
                try:
                    tmp.unlink()
                except FileNotFoundError:
                    pass
                return None
            if result.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
                try:
                    os.replace(tmp, target)
                    return target
                except OSError as e:
                    print(f"[transcode] rename failed: {e}", file=sys.stderr)
                    return None
            err = result.stderr.decode("utf-8", "replace").strip()
            if err:
                print(f"[transcode] {video.name}: {err}", file=sys.stderr)
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
            return None


def extract_frame(ffmpeg: str, video: Path, t: float, dest: Path,
                  width: int | None = None, quality: int = 2) -> bool:
    """Extract a single still frame at ``t`` seconds from ``video`` to ``dest``
    (JPEG). Returns True on success.

    Uses input seeking (``-ss`` before ``-i``), which modern ffmpeg decodes
    accurately to the requested timestamp while staying fast on long clips.
    ``quality`` is the JPEG -q:v (lower is better); ``width`` downscales for
    previews (height is kept even via scale=-2).
    """
    t = max(0.0, float(t))
    cmd = [ffmpeg, "-y", "-nostdin", "-loglevel", "error",
           "-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1"]
    if width:
        cmd += ["-vf", f"scale={int(width)}:-2"]
    cmd += ["-q:v", str(quality), "-f", "image2", str(dest)]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"[frame] {video.name}: {e}", file=sys.stderr)
        return False
    if result.returncode == 0 and dest.exists() and dest.stat().st_size > 0:
        return True
    err = result.stderr.decode("utf-8", "replace").strip()
    if err:
        print(f"[frame] {video.name} @ {t:.3f}s: {err}", file=sys.stderr)
    return False


class FrameCache:
    """Extracts and caches single still frames at arbitrary timestamps, used by
    the frontend frame-picker's filmstrip and previews. Same cache-key scheme as
    the other caches (resolve + mtime) plus the timestamp and width, so a given
    frame is only rendered once. Per-key locking avoids duplicate ffmpeg runs."""

    def __init__(self, root: Path, cache_dir: Path, ffmpeg: str = "ffmpeg",
                 quality: int = 4) -> None:
        self.root = root
        self.cache_dir = cache_dir
        self.ffmpeg = ffmpeg
        self.quality = quality
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _lock_for(self, key: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock

    def _path_for(self, video: Path, t: float, width: int) -> Path:
        st = video.stat()
        digest = hashlib.sha1(
            f"{video.resolve()}::{int(st.st_mtime_ns)}::{t:.3f}::{width}".encode("utf-8")
        ).hexdigest()
        return self.cache_dir / f"frame_{digest}.jpg"

    def get(self, video: Path, t: float, width: int | None = None) -> Path | None:
        target = self._path_for(video, t, width or 0)
        if target.exists() and target.stat().st_size > 0:
            return target
        with self._lock_for(str(target)):
            if target.exists() and target.stat().st_size > 0:
                return target
            tmp = target.with_suffix(".jpg.tmp")
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
            if extract_frame(self.ffmpeg, video, t, tmp,
                             width=width, quality=self.quality):
                try:
                    os.replace(tmp, target)
                    return target
                except OSError as e:
                    print(f"[frame] rename failed: {e}", file=sys.stderr)
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass
            return None


def frames_output_dir(root: Path) -> Path:
    """Directory where saved frames are written.

    Mirrors the layout :func:`_scan_targets` expects: if the gallery uses an
    ``images/``+``video/`` split (either present), frames go in ``images/`` so
    they surface as photos (created if missing). For a flat folder of clips they
    land next to the source media in the root.
    """
    images = root / "images"
    if images.is_dir():
        return images
    if (root / "video").is_dir() or (root / "videos").is_dir():
        images.mkdir(parents=True, exist_ok=True)
        return images
    return root


def timecode_label(t: float) -> str:
    """Filename-safe timecode, e.g. 83.456s -> '00-01-23-456'."""
    total_ms = int(round(max(0.0, t) * 1000))
    h, rem = divmod(total_ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}-{m:02d}-{s:02d}-{ms:03d}"


def _scan_targets(root: Path) -> list[tuple[Path, set[str]]]:
    """Decide which directories to scan, and with which extensions.

    The expected layout is a media root holding ``images/`` and ``video/``
    subdirectories; either may be absent. If neither exists we fall back to
    scanning the root itself for any supported media, so a plain flat folder of
    clips keeps working.
    """
    images = root / "images"
    video = root / "video"
    if not video.is_dir() and (root / "videos").is_dir():
        video = root / "videos"  # accept the plural spelling too
    targets: list[tuple[Path, set[str]]] = []
    if images.is_dir():
        targets.append((images, GALLERY_IMAGE_EXTS))
    if video.is_dir():
        targets.append((video, GALLERY_VIDEO_EXTS))
    if not targets:
        targets.append((root, GALLERY_EXTS))
    return targets


def list_media(root: Path, db_path: Path | None = None) -> list[dict]:
    cats_by_path: dict[str, list[dict]] = {}
    if db_path is not None and db_path.exists():
        with db_connect(db_path) as conn:
            cats_by_path = db_categories_by_relpath(conn)
    items = []
    for directory, exts in _scan_targets(root):
        for f in find_files(directory, exts):
            # Skip anything inside our own cache directory.
            if THUMB_DIR_NAME in f.parts:
                continue
            rel = f.relative_to(root).as_posix()
            st = f.stat()
            mid = encode_id(rel)
            is_image = f.suffix.lower() in GALLERY_IMAGE_EXTS
            item = {
                "id": mid,
                "name": f.name,
                "relpath": rel,
                "type": "image" if is_image else "video",
                "size": st.st_size,
                "size_human": human_size(st.st_size),
                "mtime": int(st.st_mtime),
                "thumbnail_url": f"/api/thumbnails/{mid}",
                "categories": cats_by_path.get(rel, []),
            }
            if is_image:
                item["image_url"] = f"/api/image/{mid}"
            else:
                item["stream_url"] = f"/api/stream/{mid}"
            items.append(item)
    items.sort(key=lambda it: it["relpath"])
    return items


# ---------------------------------------------------------------------------
# Category database
# ---------------------------------------------------------------------------
#
# Schema:
#   categories(id, name UNIQUE NOCASE) — the user's tag vocabulary.
#   video_categories(video_relpath, category_id) — many-to-many junction.
#
# Videos are referenced by their POSIX relpath under the gallery root rather
# than by the opaque base64 id, because the id is a deterministic encoding of
# the relpath and is more useful to store in raw form (greppable, portable).
# If a file is renamed on disk it loses its categories — that's acceptable.

CATEGORIES_SCHEMA = """
CREATE TABLE IF NOT EXISTS categories (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS video_categories (
    video_relpath TEXT    NOT NULL,
    category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (video_relpath, category_id)
);
CREATE INDEX IF NOT EXISTS idx_vc_relpath ON video_categories(video_relpath);
CREATE INDEX IF NOT EXISTS idx_vc_category ON video_categories(category_id);
"""


def db_connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn


def db_init(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with db_connect(db_path) as conn:
        conn.executescript(CATEGORIES_SCHEMA)


def db_list_categories(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT c.id, c.name, COUNT(vc.video_relpath) AS count "
        "FROM categories c "
        "LEFT JOIN video_categories vc ON vc.category_id = c.id "
        "GROUP BY c.id ORDER BY c.name COLLATE NOCASE"
    ).fetchall()
    return [{"id": r["id"], "name": r["name"], "count": r["count"]} for r in rows]


def db_get_or_create_category(conn: sqlite3.Connection, name: str) -> dict:
    name = name.strip()
    if not name:
        raise ValueError("category name is empty")
    if len(name) > 64:
        raise ValueError("category name is too long (max 64 chars)")
    # INSERT OR IGNORE then SELECT gives us idempotent get-or-create.
    conn.execute("INSERT OR IGNORE INTO categories(name) VALUES (?)", (name,))
    row = conn.execute(
        "SELECT id, name FROM categories WHERE name = ? COLLATE NOCASE", (name,)
    ).fetchone()
    return {"id": row["id"], "name": row["name"]}


def db_attach(conn: sqlite3.Connection, relpath: str, category_id: int) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO video_categories(video_relpath, category_id) VALUES (?, ?)",
        (relpath, category_id),
    )


def db_detach(conn: sqlite3.Connection, relpath: str, category_id: int) -> int:
    cur = conn.execute(
        "DELETE FROM video_categories WHERE video_relpath = ? AND category_id = ?",
        (relpath, category_id),
    )
    return cur.rowcount


def db_categories_by_relpath(conn: sqlite3.Connection) -> dict[str, list[dict]]:
    """Bulk-load categories for every video, keyed by relpath."""
    out: dict[str, list[dict]] = {}
    rows = conn.execute(
        "SELECT vc.video_relpath, c.id, c.name "
        "FROM video_categories vc JOIN categories c ON c.id = vc.category_id "
        "ORDER BY c.name COLLATE NOCASE"
    ).fetchall()
    for r in rows:
        out.setdefault(r["video_relpath"], []).append({"id": r["id"], "name": r["name"]})
    return out


_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class GalleryHandler(BaseHTTPRequestHandler):
    server_version = "GoProGallery/1.0"

    # Set by GalleryServer
    root: Path = None  # type: ignore[assignment]
    thumbs: ThumbnailCache = None  # type: ignore[assignment]
    transcodes: TranscodeCache = None  # type: ignore[assignment]
    frames: FrameCache = None  # type: ignore[assignment]
    db_path: Path = None  # type: ignore[assignment]

    def log_message(self, fmt: str, *args) -> None:  # quieter default log
        sys.stderr.write(f"[{self.address_string()}] {fmt % args}\n")

    # ---- helpers -------------------------------------------------------

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")

    def _send_json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status: int, message: str) -> None:
        self._send_json(status, {"error": message})

    def _resolve_video(self, vid: str) -> Path | None:
        try:
            rel = decode_id(vid)
        except Exception:
            return None
        # Guard against path traversal.
        candidate = (self.root / rel).resolve()
        try:
            candidate.relative_to(self.root.resolve())
        except ValueError:
            return None
        if not candidate.is_file():
            return None
        return candidate

    def _resolve_relpath(self, vid: str) -> str | None:
        """Validate a video id and return its relpath (for DB lookups)."""
        video = self._resolve_video(vid)
        if video is None:
            return None
        return video.relative_to(self.root).as_posix()

    def _read_json_body(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if length <= 0:
            return {}
        if length > MAX_POST_BYTES:
            self._send_error_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "body too large")
            return None
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            self._send_error_json(HTTPStatus.BAD_REQUEST, f"invalid JSON: {e}")
            return None
        if not isinstance(data, dict):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "body must be a JSON object")
            return None
        return data

    # ---- routing -------------------------------------------------------

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        path = unquote(path)
        # /api/videos kept as an alias for older clients; both list all media.
        if path in ("/api/media", "/api/videos"):
            return self._send_json(HTTPStatus.OK, list_media(self.root, self.db_path))
        if path == "/api/storage":
            return self._serve_storage()
        if path == "/api/categories":
            with db_connect(self.db_path) as conn:
                return self._send_json(HTTPStatus.OK, db_list_categories(conn))
        m = re.fullmatch(r"/api/thumbnails/([^/]+)", path)
        if m:
            return self._serve_thumbnail(m.group(1))
        m = re.fullmatch(r"/api/stream/([^/]+)", path)
        if m:
            return self._serve_stream(m.group(1))
        m = re.fullmatch(r"/api/image/([^/]+)", path)
        if m:
            return self._serve_image(m.group(1))
        m = re.fullmatch(r"/api/frames/([^/]+)", path)
        if m:
            return self._serve_frame_preview(m.group(1))
        if path in ("/", "/health"):
            return self._send_json(HTTPStatus.OK, {
                "ok": True,
                "root": str(self.root),
                "items": len(list_media(self.root, self.db_path)),
            })
        self._send_error_json(HTTPStatus.NOT_FOUND, f"no route for {path}")

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        path = unquote(path)
        if path == "/api/categories":
            body = self._read_json_body()
            if body is None:
                return
            name = body.get("name")
            if not isinstance(name, str) or not name.strip():
                return self._send_error_json(HTTPStatus.BAD_REQUEST, "missing or empty 'name'")
            with db_connect(self.db_path) as conn:
                try:
                    cat = db_get_or_create_category(conn, name)
                except ValueError as e:
                    return self._send_error_json(HTTPStatus.BAD_REQUEST, str(e))
            return self._send_json(HTTPStatus.OK, cat)
        m = re.fullmatch(r"/api/videos/([^/]+)/categories", path)
        if m:
            return self._attach_category(m.group(1))
        m = re.fullmatch(r"/api/frames/([^/]+)", path)
        if m:
            return self._save_frame(m.group(1))
        self._send_error_json(HTTPStatus.NOT_FOUND, f"no route for {path}")

    def do_DELETE(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        path = unquote(path)
        m = re.fullmatch(r"/api/videos/([^/]+)/categories/(\d+)", path)
        if m:
            return self._detach_category(m.group(1), int(m.group(2)))
        m = re.fullmatch(r"/api/videos/([^/]+)", path)
        if m:
            return self._delete_video(m.group(1))
        self._send_error_json(HTTPStatus.NOT_FOUND, f"no route for {path}")

    def _serve_storage(self) -> None:
        usage = shutil.disk_usage(self.root)
        payload = {
            "root": str(self.root),
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
            "total_human": human_size(usage.total),
            "used_human": human_size(usage.used),
            "free_human": human_size(usage.free),
            "percent_used": round(usage.used * 100 / usage.total, 1) if usage.total else 0,
        }
        self._send_json(HTTPStatus.OK, payload)

    def _delete_video(self, vid: str) -> None:
        video = self._resolve_video(vid)
        if video is None:
            return self._send_error_json(HTTPStatus.NOT_FOUND, "video not found")
        relpath = video.relative_to(self.root).as_posix()
        # Remove derived caches before unlinking — both cache keys depend on
        # the source file's mtime, so we can't recompute them post-delete.
        self.thumbs.delete_for(video)
        self.transcodes.delete_for(video)
        aux_companions = find_aux_companions(video)
        try:
            video.unlink()
        except OSError as e:
            return self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR,
                                         f"failed to delete file: {e}")
        for aux in aux_companions:
            try:
                aux.unlink()
            except OSError as e:
                print(f"[delete] failed to remove aux {aux}: {e}", file=sys.stderr)
        try:
            with db_connect(self.db_path) as conn:
                conn.execute(
                    "DELETE FROM video_categories WHERE video_relpath = ?",
                    (relpath,),
                )
        except sqlite3.Error as e:
            print(f"[delete] db cleanup failed for {relpath}: {e}", file=sys.stderr)
        self._send_json(HTTPStatus.OK, {"ok": True, "deleted": relpath})

    def _attach_category(self, vid: str) -> None:
        relpath = self._resolve_relpath(vid)
        if relpath is None:
            return self._send_error_json(HTTPStatus.NOT_FOUND, "video not found")
        body = self._read_json_body()
        if body is None:
            return
        name = body.get("name")
        cat_id = body.get("id")
        with db_connect(self.db_path) as conn:
            if isinstance(cat_id, int):
                row = conn.execute(
                    "SELECT id, name FROM categories WHERE id = ?", (cat_id,)
                ).fetchone()
                if row is None:
                    return self._send_error_json(HTTPStatus.NOT_FOUND, "category not found")
                cat = {"id": row["id"], "name": row["name"]}
            elif isinstance(name, str) and name.strip():
                try:
                    cat = db_get_or_create_category(conn, name)
                except ValueError as e:
                    return self._send_error_json(HTTPStatus.BAD_REQUEST, str(e))
            else:
                return self._send_error_json(HTTPStatus.BAD_REQUEST,
                                             "provide 'name' or 'id'")
            db_attach(conn, relpath, cat["id"])
        self._send_json(HTTPStatus.OK, cat)

    def _detach_category(self, vid: str, cat_id: int) -> None:
        relpath = self._resolve_relpath(vid)
        if relpath is None:
            return self._send_error_json(HTTPStatus.NOT_FOUND, "video not found")
        with db_connect(self.db_path) as conn:
            db_detach(conn, relpath, cat_id)
        self._send_json(HTTPStatus.OK, {"ok": True})

    # ---- endpoints -----------------------------------------------------

    def _serve_image(self, vid: str) -> None:
        img = self._resolve_video(vid)  # generic file resolver with traversal guard
        if img is None:
            return self._send_error_json(HTTPStatus.NOT_FOUND, "image not found")
        self._serve_file_range(img)

    def _serve_frame_preview(self, vid: str) -> None:
        """Extract (and cache) a downscaled still at ?t=<sec> for the frame
        picker's filmstrip. ?w=<px> sets the preview width."""
        video = self._resolve_video(vid)
        if video is None:
            return self._send_error_json(HTTPStatus.NOT_FOUND, "video not found")
        if video.suffix.lower() not in GALLERY_VIDEO_EXTS:
            return self._send_error_json(HTTPStatus.BAD_REQUEST, "not a video")
        qs = parse_qs(urlparse(self.path).query)
        try:
            t = float((qs.get("t") or ["0"])[0])
        except ValueError:
            return self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid 't'")
        width: int | None = None
        if qs.get("w"):
            try:
                width = max(16, min(3840, int(qs["w"][0])))
            except ValueError:
                width = None
        frame = self.frames.get(video, t, width=width)
        if frame is None:
            return self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR,
                                         "frame extraction failed")
        size = frame.stat().st_size
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "public, max-age=3600")
        self._cors()
        self.end_headers()
        with frame.open("rb") as fh:
            shutil.copyfileobj(fh, self.wfile)

    def _save_frame(self, vid: str) -> None:
        """Extract a full-resolution still at body {"t": <sec>} and save it into
        the gallery as a new photo. Returns the new media item."""
        video = self._resolve_video(vid)
        if video is None:
            return self._send_error_json(HTTPStatus.NOT_FOUND, "video not found")
        if video.suffix.lower() not in GALLERY_VIDEO_EXTS:
            return self._send_error_json(HTTPStatus.BAD_REQUEST, "not a video")
        body = self._read_json_body()
        if body is None:
            return
        t = body.get("t")
        if not isinstance(t, (int, float)) or isinstance(t, bool) or t < 0:
            return self._send_error_json(HTTPStatus.BAD_REQUEST,
                                         "missing or invalid 't' (seconds)")
        out_dir = frames_output_dir(self.root)
        dest = unique_dest(out_dir, f"{video.stem}_frame_{timecode_label(float(t))}.jpg")
        if not extract_frame(self.frames.ffmpeg, video, float(t), dest, quality=2):
            return self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR,
                                         "frame extraction failed")
        rel = dest.relative_to(self.root).as_posix()
        st = dest.stat()
        mid = encode_id(rel)
        item = {
            "id": mid,
            "name": dest.name,
            "relpath": rel,
            "type": "image",
            "size": st.st_size,
            "size_human": human_size(st.st_size),
            "mtime": int(st.st_mtime),
            "thumbnail_url": f"/api/thumbnails/{mid}",
            "image_url": f"/api/image/{mid}",
            "categories": [],
        }
        self._send_json(HTTPStatus.OK, {"ok": True, "item": item})

    def _serve_thumbnail(self, vid: str) -> None:
        video = self._resolve_video(vid)
        if video is None:
            return self._send_error_json(HTTPStatus.NOT_FOUND, "media not found")
        is_image = video.suffix.lower() in GALLERY_IMAGE_EXTS
        thumb = self.thumbs.get(video, is_image=is_image)
        if thumb is None:
            # Images can still be shown at full size if ffmpeg couldn't make a
            # downscaled thumbnail; videos have no such fallback.
            if is_image:
                return self._serve_file_range(video)
            return self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR,
                                         "thumbnail generation failed")
        size = thumb.stat().st_size
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "public, max-age=86400")
        self._cors()
        self.end_headers()
        with thumb.open("rb") as fh:
            shutil.copyfileobj(fh, self.wfile)

    def _serve_stream(self, vid: str) -> None:
        video = self._resolve_video(vid)
        if video is None:
            return self._send_error_json(HTTPStatus.NOT_FOUND, "video not found")
        qs = parse_qs(urlparse(self.path).query)
        quality = (qs.get("q") or [""])[0]
        if quality == "mobile":
            target = self.transcodes.get(video)
            if target is None:
                return self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR,
                                             "mobile transcode failed")
        else:
            target = video
        self._serve_file_range(target)

    def _serve_file_range(self, target: Path) -> None:
        total = target.stat().st_size
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, total - 1
        partial = False
        if rng:
            m = _RANGE_RE.fullmatch(rng.strip())
            if not m:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{total}")
                self._cors()
                self.end_headers()
                return
            s, e = m.group(1), m.group(2)
            if s == "" and e == "":
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{total}")
                self._cors()
                self.end_headers()
                return
            if s == "":  # suffix length
                length = int(e)
                start = max(0, total - length)
                end = total - 1
            else:
                start = int(s)
                end = int(e) if e else total - 1
            if start > end or end >= total:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{total}")
                self._cors()
                self.end_headers()
                return
            partial = True

        length = end - start + 1
        self.send_response(HTTPStatus.PARTIAL_CONTENT if partial else HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self._cors()
        self.end_headers()

        with target.open("rb") as fh:
            fh.seek(start)
            remaining = length
            chunk = 64 * 1024
            while remaining > 0:
                data = fh.read(min(chunk, remaining))
                if not data:
                    break
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(data)


def cmd_serve(args: argparse.Namespace) -> int:
    root: Path = args.directory.expanduser().resolve()
    if not root.is_dir():
        print(f"error: directory does not exist: {root}", file=sys.stderr)
        return 2
    cache_dir = (args.cache_dir.expanduser().resolve()
                 if args.cache_dir else root / THUMB_DIR_NAME)
    cache_dir.mkdir(parents=True, exist_ok=True)
    db_path = (args.db.expanduser().resolve()
               if args.db else cache_dir / CATEGORIES_DB_NAME)
    db_init(db_path)
    thumbs = ThumbnailCache(root=root, cache_dir=cache_dir,
                            seek_seconds=args.seek, width=args.thumb_width)
    transcodes = TranscodeCache(root=root, cache_dir=cache_dir,
                                height=args.mobile_height, crf=args.mobile_crf)
    frames = FrameCache(root=root, cache_dir=cache_dir)

    if args.prewarm:
        items = list_media(root, db_path)
        print(f"Pre-warming {len(items)} thumbnail(s) in {cache_dir}...")
        for item in items:
            full = root / item["relpath"]
            t = thumbs.get(full, is_image=item["type"] == "image")
            print(f"  {'OK ' if t else 'FAIL'} {item['relpath']}")

    handler = GalleryHandler
    handler.root = root
    handler.thumbs = thumbs
    handler.transcodes = transcodes
    handler.frames = frames
    handler.db_path = db_path

    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving {root}")
    print(f"  cache:  {cache_dir}")
    print(f"  db:     {db_path}")
    print(f"  api:    http://{args.host}:{args.port}/api/media")
    print("  press Ctrl-C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()
    return 0


# ---------------------------------------------------------------------------
# CLI plumbing
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gopro",
        description="Export GoPro footage and serve a gallery REST API.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    subs = parser.add_subparsers(dest="command", required=True)

    p_export = subs.add_parser(
        "export",
        help="Export video files from an SD card or directory.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p_export.add_argument("input", type=Path, help="Source directory (e.g. SD card mount or DCIM folder)")
    p_export.add_argument("output", type=Path, help="Destination directory")
    p_export.add_argument("--delete", action="store_true", help="Delete source files after successful copy")
    p_export.add_argument("--include-aux", action="store_true", help="Also export .LRV/.THM/.WAV sidecar files")
    p_export.add_argument("--dry-run", action="store_true", help="Show what would be copied without copying")
    p_export.add_argument("--ext", action="append", default=None,
                          help="Override extensions (repeatable). Replaces defaults.")
    p_export.add_argument("-y", "--yes", action="store_true", help="Skip confirmation prompt before --delete")
    p_export.set_defaults(func=cmd_export)

    p_serve = subs.add_parser(
        "serve",
        help="Serve a media directory (images + video) via a REST API.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p_serve.add_argument("directory", type=Path,
                         help="Media root. Scans images/ and video/ subdirectories if present, "
                              "otherwise the directory itself.")
    p_serve.add_argument("--host", default="127.0.0.1", help="Host to bind")
    p_serve.add_argument("--port", type=int, default=8787, help="Port to bind")
    p_serve.add_argument("--cache-dir", type=Path, default=None,
                         help="Thumbnail cache directory (default: <directory>/.thumbnails)")
    p_serve.add_argument("--db", type=Path, default=None,
                         help="SQLite categories DB path (default: <cache-dir>/categories.db)")
    p_serve.add_argument("--seek", type=float, default=1.0,
                         help="Seconds into the video to grab the thumbnail frame")
    p_serve.add_argument("--thumb-width", type=int, default=480, help="Thumbnail width in pixels")
    p_serve.add_argument("--mobile-height", type=int, default=720,
                         help="Vertical resolution for the mobile transcode")
    p_serve.add_argument("--mobile-crf", type=int, default=23,
                         help="x264 CRF for the mobile transcode (lower = better, larger)")
    p_serve.add_argument("--prewarm", action="store_true",
                         help="Pre-generate thumbnails for all videos on startup")
    p_serve.set_defaults(func=cmd_serve)

    return parser


def main() -> int:
    signal.signal(signal.SIGINT, lambda *_: sys.exit("\nAborted."))
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
