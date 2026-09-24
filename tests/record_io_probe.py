"""Logical file I/O meter, including SQLite's C-level database/journal I/O.

Test/benchmark only. Wrap the platform SQLite VFS (no simulated database) and
Python file operations. Counts requested VFS read bytes, including short reads;
counts actual Python reads and writes. Excludes filesystem metadata and fsync.
All connections must close before the context exits. No subprocess I/O counted.

Portability: the VFS hook needs CPython's ``_sqlite3`` extension, a resolvable
``sqlite3_vfs_find`` symbol (the extension's own SQLite or the shared library it
links) and a default VFS with ``iVersion`` 1..3 whose struct layouts match the
``ctypes`` mirrors below. When any of that is unavailable, or the installed hook
provably intercepts no SQLite I/O (self-check on a scratch database), the meter
raises ``IoMeterUnsupported`` *before yielding* so a caller can skip cleanly.
It never yields Python-only counts as if they were the total.
"""
import ctypes as C
import io
import os
import sqlite3
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

SUPPORTED_VFS_VERSIONS = (1, 2, 3)


class IoMeterUnsupported(RuntimeError):
    """The native SQLite VFS hook cannot be installed or verified on this interpreter/platform."""


class _Methods(C.Structure):
    _fields_ = [('version', C.c_int)] + [(name, C.c_void_p) for name in (
        'close', 'read', 'write', 'truncate', 'sync', 'size', 'lock', 'unlock',
        'reserved', 'control', 'sector', 'device', 'shmmap', 'shmlock',
        'shmbarrier', 'shmunmap', 'fetch', 'unfetch')]


class _File(C.Structure):
    _fields_ = [('methods', C.POINTER(_Methods))]


class _VFS(C.Structure):
    _fields_ = [('version', C.c_int), ('szfile', C.c_int), ('mxpath', C.c_int),
                ('next', C.c_void_p), ('name', C.c_char_p), ('app', C.c_void_p)] + [
        (name, C.c_void_p) for name in ('open', 'delete', 'access', 'fullpath',
        'dlopen', 'dlerror', 'dlsym', 'dlclose', 'randomness', 'sleep', 'time',
        'error', 'time64', 'setsyscall', 'getsyscall', 'nextsyscall')]


def _sqlite_library():
    """Return a ctypes handle exposing the SQLite VFS registry used by ``sqlite3``; raise OSError/AttributeError if not."""
    if sys.implementation.name != 'cpython':
        raise OSError(f'{sys.implementation.name} has no native _sqlite3 extension to hook')
    import _sqlite3
    candidates = [getattr(_sqlite3, '__file__', None), None]  # None = the process's global symbol table (static builds)
    errors = []
    for candidate in candidates:
        try:
            lib = C.CDLL(candidate)
            lib.sqlite3_vfs_find.argtypes = [C.c_char_p]
            lib.sqlite3_vfs_find.restype = C.POINTER(_VFS)
            lib.sqlite3_vfs_register.argtypes = [C.POINTER(_VFS), C.c_int]
            lib.sqlite3_vfs_unregister.argtypes = [C.POINTER(_VFS)]
            return lib
        except (OSError, AttributeError, TypeError) as exc:
            errors.append(f'{candidate or "<process>"}: {exc}')
    raise OSError('sqlite3_vfs_find not resolvable from ' + '; '.join(errors))


def _exercise_sqlite(path: Path) -> None:
    """Perform real SQLite writes and reads on a scratch database through the *default* VFS (hook self-check)."""
    db = sqlite3.connect(path)
    try:
        db.execute('PRAGMA journal_mode=DELETE')
        db.execute('CREATE TABLE probe (x)')
        db.execute('INSERT INTO probe VALUES (1)')
        db.commit()
    finally:
        db.close()
    db = sqlite3.connect(path)
    try:
        assert db.execute('SELECT x FROM probe').fetchone() == (1,)
    finally:
        db.close()


def unsupported_reason():
    """None when the full meter (VFS hook + Python patches) works here, else the reason to skip."""
    try:
        with measure_io():
            pass
    except IoMeterUnsupported as exc:
        return str(exc)
    return None


@contextmanager
def measure_io():
    counts = {'read': 0, 'write': 0, 'sqlite_read': 0, 'sqlite_write': 0}
    try:
        lib = _sqlite_library()
        original = lib.sqlite3_vfs_find(None)
        if not original:
            raise OSError('sqlite3_vfs_find(NULL) returned no default VFS')
        if original.contents.version not in SUPPORTED_VFS_VERSIONS:
            raise OSError(f'default VFS iVersion {original.contents.version} does not match the ctypes layout')
    except (OSError, AttributeError, ImportError, ValueError) as exc:
        raise IoMeterUnsupported(str(exc)) from exc
    vfs = _VFS.from_buffer_copy(original.contents)
    vfs.name = b'orchestrator-test-io'
    # Keep SQLite's original filename pointer: unix VFS retains it after xOpen.
    open_type = C.CFUNCTYPE(C.c_int, C.c_void_p, C.c_void_p, C.POINTER(_File), C.c_int, C.POINTER(C.c_int))
    io_type = C.CFUNCTYPE(C.c_int, C.POINTER(_File), C.c_void_p, C.c_int, C.c_int64)
    open_real = open_type(original.contents.open)
    keep = {}

    @open_type
    def open_counted(v, name, file, flags, out_flags):
        result = open_real(original, name, file, flags, out_flags)
        if result == 0 and file.contents.methods:
            old = file.contents.methods.contents
            key = C.addressof(old)
            if key not in keep:
                methods = _Methods.from_buffer_copy(old)
                read_real, write_real = io_type(old.read), io_type(old.write)

                @io_type
                def read(f, buf, n, offset):
                    counts['read'] += n; counts['sqlite_read'] += n
                    return read_real(f, buf, n, offset)

                @io_type
                def write(f, buf, n, offset):
                    counts['write'] += n; counts['sqlite_write'] += n
                    return write_real(f, buf, n, offset)

                methods.read = C.cast(read, C.c_void_p).value
                methods.write = C.cast(write, C.c_void_p).value
                keep[key] = (methods, read, write)
            file.contents.methods = C.pointer(keep[key][0])
        return result

    vfs.open = C.cast(open_counted, C.c_void_p).value
    if lib.sqlite3_vfs_register(C.byref(vfs), 1) != 0:
        raise IoMeterUnsupported('sqlite3_vfs_register refused the counting VFS')
    try:
        # Self-check: the sqlite3 module must actually route through the hooked default VFS.
        with tempfile.TemporaryDirectory() as scratch:
            _exercise_sqlite(Path(scratch, 'probe.sqlite3'))
        if counts['sqlite_write'] == 0 or counts['sqlite_read'] == 0:
            raise IoMeterUnsupported('the counting VFS was registered but sqlite3 I/O bypassed it; '
                                     'refusing to report Python-only I/O as the total')
        for key in counts:
            counts[key] = 0
        real_open, real_fdopen, real_write, real_pread = io.open, os.fdopen, os.write, os.pread

        def length(data):
            return len(data.encode('utf-8') if isinstance(data, str) else data)

        class File:
            def __init__(self, raw): self.raw = raw
            def read(self, *args):
                data = self.raw.read(*args); counts['read'] += length(data); return data
            def readline(self, *args):
                data = self.raw.readline(*args); counts['read'] += length(data); return data
            def write(self, data):
                n = self.raw.write(data); counts['write'] += length(data[:n]); return n
            def __iter__(self): return self
            def __next__(self):
                data = next(self.raw); counts['read'] += length(data); return data
            def __enter__(self): return self
            def __exit__(self, *exc): return self.raw.__exit__(*exc)
            def __getattr__(self, name): return getattr(self.raw, name)

        def write(fd, data):
            n = real_write(fd, data); counts['write'] += n; return n
        def pread(*args):
            data = real_pread(*args); counts['read'] += len(data); return data

        def wrap(raw):
            # os.fdopen delegates to io.open on CPython; never wrap the same I/O twice.
            return raw if isinstance(raw, File) else File(raw)

        with patch('io.open', lambda *a, **k: wrap(real_open(*a, **k))), \
             patch('os.fdopen', lambda *a, **k: wrap(real_fdopen(*a, **k))), \
             patch('os.write', write), patch('os.pread', pread):
            yield counts
    finally:
        lib.sqlite3_vfs_register(original, 1)
        lib.sqlite3_vfs_unregister(C.byref(vfs))
