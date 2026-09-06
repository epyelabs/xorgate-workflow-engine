"""The Python function runner: one process per `function.python` node instance
per run, spawned by the engine (src/engine/function-runtime.ts) as

    python3 -I -S -B -u runner.py

(isolated mode: no environment variables, no user site, no site-packages).
It speaks one JSON object per line: requests on stdin, answers on stdout,
diagnostics on stderr; the protocol is the JavaScript runner's (runtime/js/runner.cjs).

    -> { "t": "init", "code", "handler", "version", "nodeId", "runId", "timeoutMs", "memoryMb" }
    <- { "t": "ready", "runtime", "limits" }   | { "t": "error", "message", "stack", "logs" }
    -> { "t": "event", "seq", "event": { "tag", "ts", "seq", "payload" }, "timeoutMs" }
    <- { "t": "log", "seq", "line" }            (zero or more, as context.log is called)
    <- { "t": "result", "seq", "value", "logs", "durationMs" }
       | { "t": "error", "seq", "message", "stack", "logs", "durationMs" }
    -> { "t": "close" }                         (or end of stdin) -> exit 0

What the user's code gets: the standard library, minus the modules that reach
the network, the file system or other processes (the deny list below), and a
builtins module whose `open` refuses. `print()` goes to the invocation log.
Memory is capped with RLIMIT_AS from `memoryMb` where the platform enforces
it; the engine kills the process on `timeoutMs`. These guards are at the
import layer and are best effort: the interpreter is not a security
boundary, the container image is.
"""

import asyncio
import builtins
import io
import json
import os
import sys
import time
import traceback

_real_stdout = sys.stdout
_real_stderr = sys.stderr

MAX_LOG_LINE_CHARS = 4096
MAX_LOG_LINES_PER_INVOCATION = 1000
USER_MODULE = "__handler__"
USER_FILE = "handler.py"

# Modules the user's code may not import: anything that opens sockets, runs
# processes, touches files or reaches into the interpreter.
DENIED_MODULES = frozenset(
    """
    socket _socket ssl select selectors asyncio http urllib ftplib smtplib poplib imaplib
    nntplib telnetlib xmlrpc socketserver wsgiref webbrowser
    subprocess _posixsubprocess multiprocessing concurrent signal
    os posix nt pathlib shutil tempfile glob fileinput linecache mmap
    sqlite3 dbm shelve zipfile tarfile
    ctypes _ctypes importlib pkgutil runpy zipimport sys _io gc inspect resource
    faulthandler pty tty termios fcntl pwd grp pdb code codeop
    """.split()
)


def _send(obj):
    _real_stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    _real_stdout.flush()


class _State:
    seq = -1
    deadline = 0.0
    logs = []
    dropped = 0


_state = _State()


def _push_log(line):
    if len(_state.logs) >= MAX_LOG_LINES_PER_INVOCATION:
        _state.dropped += 1
        return
    if len(line) > MAX_LOG_LINE_CHARS:
        line = line[:MAX_LOG_LINE_CHARS] + "…"
    _state.logs.append(line)
    _send({"t": "log", "seq": _state.seq, "line": line})


class _LogStream(io.TextIOBase):
    """sys.stdout for the user's code: every completed line is a log line."""

    def __init__(self):
        super().__init__()
        self._buf = ""

    def writable(self):
        return True

    def write(self, s):
        s = str(s)
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            _push_log(line)
        return len(s)

    def flush(self):
        if self._buf:
            _push_log(self._buf)
            self._buf = ""


def _denied(what):
    return PermissionError(
        f"{what} is not available in a code function: no module access beyond the standard library, "
        "no file system, no network (ERR_ACCESS_DENIED)"
    )


_real_import = builtins.__import__


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    importer = globals.get("__name__") if isinstance(globals, dict) else None
    if importer is None or importer == USER_MODULE:
        top = name.partition(".")[0]
        if top in DENIED_MODULES or level != 0:
            raise _denied(f"import {name}")
    return _real_import(name, globals, locals, fromlist, level)


def _denied_open(*args, **kwargs):
    target = repr(args[0]) if args else ""
    raise _denied(f"open({target})")


def _install_guards():
    builtins.__import__ = _guarded_import
    builtins.open = _denied_open
    io.open = _denied_open
    io.open_code = _denied_open
    io.FileIO = _denied_open
    # The runner's own directory is the first sys.path entry; nothing else
    # should be importable from there.
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if p and os.path.abspath(p) != here]
    sys.stdout = _LogStream()


def _apply_memory_limit(memory_mb):
    try:
        import resource  # noqa: WPS433 (runner-level import, before the guard)
    except ImportError:
        return "unsupported"
    limit = int(memory_mb) * 1024 * 1024
    try:
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        return f"rlimit_as {int(memory_mb)} MB"
    except (ValueError, OSError) as err:  # macOS refuses an address-space limit
        return f"not enforced ({err.__class__.__name__})"


def _describe(err):
    """(message, trace) with only the frames inside the user's code."""
    message = f"{err.__class__.__name__}: {err}" if not isinstance(err, SyntaxError) else _syntax_message(err)
    frames = []
    for frame in traceback.extract_tb(err.__traceback__):
        if frame.filename == USER_FILE:
            frames.append(f"    at {frame.name} ({USER_FILE}:{frame.lineno})")
    return message, "\n".join(frames)


def _syntax_message(err):
    where = f" ({USER_FILE}:{err.lineno})" if err.lineno else ""
    return f"SyntaxError: {err.msg}{where}"


class _Context:
    __slots__ = ("nodeId", "runId", "functionVersion")

    def __init__(self, node_id, run_id, function_version):
        self.nodeId = node_id
        self.runId = run_id
        self.functionVersion = function_version

    @staticmethod
    def log(*args):
        _push_log(" ".join(_fmt(a) for a in args))

    @staticmethod
    def remainingTimeMs():
        return max(0, int((_state.deadline - time.monotonic()) * 1000))


def _fmt(value):
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


class _Runner:
    def __init__(self):
        self.handler = None
        self.node_id = ""
        self.run_id = ""
        self.function_version = "$LATEST"

    def init(self, msg):
        self.node_id = str(msg.get("nodeId", ""))
        self.run_id = str(msg.get("runId", ""))
        version = msg.get("version")
        self.function_version = "$LATEST" if version is None else version
        _state.seq = -1
        _state.logs = []
        _state.dropped = 0
        name = str(msg.get("handler", "handler"))
        if not name.isidentifier():
            raise ValueError(f'handler "{name}" is not a valid identifier')
        code = compile(str(msg.get("code", "")), USER_FILE, "exec")
        namespace = {"__name__": USER_MODULE, "__builtins__": builtins}
        exec(code, namespace)
        fn = namespace.get(name)
        if not callable(fn):
            raise TypeError(f'handler "{name}" is not a function in the code (define `def {name}(event, context)`)')
        self.handler = fn

    def event(self, msg):
        seq = msg.get("seq", 0)
        _state.seq = seq
        _state.logs = []
        _state.dropped = 0
        started = time.monotonic()
        _state.deadline = started + float(msg.get("timeoutMs", 3000)) / 1000.0
        try:
            if self.handler is None:
                raise RuntimeError("event before init")
            context = _Context(self.node_id, self.run_id, self.function_version)
            value = self.handler(msg.get("event"), context)
            if _is_coroutine(value):
                value = _run_coroutine(value)
            sys.stdout.flush()
            duration_ms = int((time.monotonic() - started) * 1000)
            if _state.dropped:
                _state.logs.append(f"… {_state.dropped} more log line(s) dropped")
            if value is None:
                encoded = "null"
            else:
                encoded = json.dumps(value, separators=(",", ":"), allow_nan=False)
            _real_stdout.write(
                '{"t":"result","seq":%s,"value":%s,"logs":%s,"durationMs":%d}\n'
                % (json.dumps(seq), encoded, json.dumps(_state.logs, separators=(",", ":")), duration_ms)
            )
            _real_stdout.flush()
        except BaseException as err:  # noqa: BLE001 (every failure is the invocation's)
            try:
                sys.stdout.flush()
            except Exception:  # noqa: BLE001
                pass
            message, stack = _describe(err)
            _send(
                {
                    "t": "error",
                    "seq": seq,
                    "message": message,
                    "stack": stack,
                    "logs": _state.logs,
                    "durationMs": int((time.monotonic() - started) * 1000),
                }
            )


def _is_coroutine(value):
    return hasattr(value, "send") and hasattr(value, "throw") and hasattr(value, "close") and hasattr(value, "__await__")


def _run_coroutine(coro):
    return asyncio.run(coro)


def main():
    runner = _Runner()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            _send({"t": "error", "seq": -1, "message": "Error: malformed request line", "stack": "", "logs": [], "durationMs": 0})
            continue
        kind = msg.get("t")
        if kind == "init":
            limits = {"memory": _apply_memory_limit(msg.get("memoryMb", 256))}
            try:
                runner.init(msg)
            except BaseException as err:  # noqa: BLE001
                message, stack = _describe(err)
                _send({"t": "error", "seq": -1, "message": message, "stack": stack, "logs": [], "durationMs": 0})
                continue
            _send({"t": "ready", "runtime": f"python {sys.version.split()[0]}", "limits": limits})
        elif kind == "event":
            runner.event(msg)
        elif kind == "close":
            return 0
        else:
            _send({"t": "error", "seq": msg.get("seq", -1), "message": f'Error: unknown message type "{kind}"', "stack": "", "logs": [], "durationMs": 0})
    return 0


if __name__ == "__main__":
    _install_guards()
    sys.exit(main())
