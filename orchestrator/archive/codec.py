"""Hashing/compression primitives: private temp files, SHA-256 digests, gzip in/out.

Split out of `orchestrator/archive.py` (B3, `docs/architecture-review.md`); see
`orchestrator/archive/__init__.py` for the package overview and re-export contract.
"""
from __future__ import annotations

import gzip
import hashlib
import os
import stat
import tempfile
import zlib
from pathlib import Path

CHUNK = 1 << 20
SAMPLE_BYTES = 256 * 1024
COMPRESS_LEVEL = 6
EMPTY_GZIP_BYTES = 20  # header + empty deflate block + trailer


def _private_temp(dest: Path) -> tuple[int, Path]:
    # mkstemp uses O_EXCL and mode 0600 from creation, regardless of the caller's umask.
    fd, name = tempfile.mkstemp(prefix=f'.{dest.name}.', suffix='.tmp', dir=dest.parent)
    return fd, Path(name)


def _open_regular(path: Path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError(f'not a regular file: {path}')
        return os.fdopen(fd, 'rb')
    except BaseException:
        os.close(fd)
        raise


def _digest_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256(); n = 0
    with _open_regular(path) as f:
        for chunk in iter(lambda: f.read(CHUNK), b''): h.update(chunk); n += len(chunk)
    return h.hexdigest(), n


def _decompressed_digest(archive_path: Path) -> tuple[str, int]:
    """SHA-256 and byte count of the fully decompressed archive (raises on corrupt gzip data)."""
    h = hashlib.sha256(); n = 0
    with _open_regular(archive_path) as source, gzip.GzipFile(fileobj=source, mode='rb') as f:
        for chunk in iter(lambda: f.read(CHUNK), b''): h.update(chunk); n += len(chunk)
    return h.hexdigest(), n


def _compress_to_temp(src: Path, dest: Path) -> tuple[Path, str, int]:
    """gzip `src` into a fresh same-directory temp file for `dest`; return (tmp, raw sha256, raw bytes). fsynced."""
    fd, tmp = _private_temp(dest)
    try:
        h = hashlib.sha256(); n = 0
        with os.fdopen(fd, 'wb') as raw_out:
            # mtime=0 and no embedded filename: identical input yields identical archive bytes.
            with gzip.GzipFile(filename='', mode='wb', fileobj=raw_out, compresslevel=COMPRESS_LEVEL, mtime=0) as gz, _open_regular(src) as f:
                for chunk in iter(lambda: f.read(CHUNK), b''): h.update(chunk); n += len(chunk); gz.write(chunk)
            raw_out.flush(); os.fsync(raw_out.fileno())
        return tmp, h.hexdigest(), n
    except BaseException:
        _unlink_quietly(tmp); raise


def _decompress_to_temp(archive_path: Path, dest: Path) -> tuple[Path, str, int]:
    fd, tmp = _private_temp(dest)
    try:
        h = hashlib.sha256(); n = 0
        with os.fdopen(fd, 'wb') as out, _open_regular(archive_path) as source, gzip.GzipFile(fileobj=source, mode='rb') as f:
            for chunk in iter(lambda: f.read(CHUNK), b''): h.update(chunk); n += len(chunk); out.write(chunk)
            out.flush(); os.fsync(out.fileno())
        return tmp, h.hexdigest(), n
    except BaseException:
        _unlink_quietly(tmp); raise


def _unlink_quietly(path: Path) -> None:
    try: path.unlink()
    except FileNotFoundError: pass


def estimate_compressed_bytes(path: Path, size: int) -> int:
    """Estimate from compressed samples at the head, middle and tail (read-only; exact-ish up to the sample size).

    Event streams compress unevenly (short handshake lines first, big tool outputs later), so a
    head-only sample under-estimates them badly; three windows keep the estimate honest and cheap.
    """
    if size <= 0: return EMPTY_GZIP_BYTES
    with _open_regular(path) as f:
        if size <= SAMPLE_BYTES: return len(zlib.compress(f.read(), COMPRESS_LEVEL)) + 18  # gzip header/trailer over the deflate body
        window = SAMPLE_BYTES // 3; sampled = 0; compressed = 0
        for offset in (0, (size - window) // 2, size - window):
            f.seek(offset); chunk = f.read(window); sampled += len(chunk); compressed += len(zlib.compress(chunk, COMPRESS_LEVEL))
    return max(18, int(round(compressed * (size / max(1, sampled)))) + 18)
