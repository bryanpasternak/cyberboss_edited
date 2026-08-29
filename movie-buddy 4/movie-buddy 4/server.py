"""Local HTTP and speech service for Movie Buddy.

Binds to the loopback interface only. Serves the player UI, accepts one
"current moment" at a time from the browser, hands it to whichever AI backend
is configured, and reports the backend's reply back to the page.
"""

from __future__ import annotations

import atexit
import base64
import json
import mimetypes
import os
import subprocess
import tempfile
import threading
import uuid
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "runtime"
QUEUE_FILE = RUNTIME / "message_queue.jsonl"
FRAME_FILE = RUNTIME / "current_frame.jpg"
STATUS_FILE = RUNTIME / "bridge_status.json"
RESPONSE_FILE = RUNTIME / "response.json"
MAX_AUDIO_BYTES = 32 * 1024 * 1024
MAX_FRAME_BYTES = 8 * 1024 * 1024

BRIDGES = {"claude": "claude_bridge.js", "codex": "codex_bridge.js"}

_BRIDGE: subprocess.Popen | None = None
_MODEL = None
_MODEL_LOCK = threading.Lock()


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

def deep_merge(base: dict, override: dict) -> dict:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_config() -> dict:
    defaults = read_json(ROOT / "config.example.json", {})
    local = read_json(ROOT / "config.json", None)
    config = deep_merge(defaults, local) if isinstance(local, dict) else defaults
    config.pop("//", None)
    return config


def read_json(path: Path, fallback: object) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


CONFIG = load_config()
SERVER_CONFIG = CONFIG.get("server", {})
HOST = str(SERVER_CONFIG.get("host", "127.0.0.1"))
PORT = int(SERVER_CONFIG.get("port", 4174))
ORIGIN = f"http://{HOST}:{PORT}"
ALLOWED_HOSTS = {f"{HOST}:{PORT}", f"localhost:{PORT}"}
ALLOWED_ORIGINS = {ORIGIN, f"http://localhost:{PORT}"}
PROMPTS = CONFIG.get("prompts", {})


def prompt(key: str, fallback: str) -> str:
    value = PROMPTS.get(key)
    return str(value) if isinstance(value, str) and value else fallback


# --------------------------------------------------------------------------
# Runtime helpers
# --------------------------------------------------------------------------

def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    temp.write_bytes(data)
    temp.replace(path)


def write_status(status: str, **extra: object) -> None:
    atomic_write(STATUS_FILE, json.dumps({"status": status, **extra}, ensure_ascii=False).encode("utf-8"))


def start_bridge() -> None:
    global _BRIDGE
    RUNTIME.mkdir(parents=True, exist_ok=True)
    backend = str(CONFIG.get("backend", "claude")).lower()
    script = BRIDGES.get(backend)
    if script is None:
        write_status("error", error=f"Unknown backend {backend!r}. Use one of: {', '.join(BRIDGES)}.")
        return

    env = dict(os.environ, MOVIE_BUDDY_CONFIG=json.dumps(CONFIG, ensure_ascii=False))
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        _BRIDGE = subprocess.Popen(
            ["node", str(ROOT / script)],
            cwd=ROOT,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            creationflags=flags,
        )
    except FileNotFoundError:
        write_status("error", error="Node.js was not found on PATH. Install Node 18 or newer, then restart Movie Buddy.")
        print("Movie Buddy: Node.js is required for the AI bridge but was not found on PATH.", flush=True)


def stop_bridge() -> None:
    if _BRIDGE and _BRIDGE.poll() is None:
        _BRIDGE.terminate()


def transcribe_audio(audio: bytes, suffix: str = ".webm") -> str:
    global _MODEL
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "faster-whisper is not installed. Run: pip install -r requirements.txt"
        ) from exc

    whisper = CONFIG.get("whisper", {})
    model_name = os.environ.get("MOVIE_BUDDY_WHISPER_MODEL") or str(whisper.get("model", "base"))
    configured_root = os.environ.get("MOVIE_BUDDY_MODEL_ROOT", "").strip()
    model_root = Path(configured_root) if configured_root else RUNTIME / "models"
    model_root.mkdir(parents=True, exist_ok=True)

    with _MODEL_LOCK:
        if _MODEL is None:
            _MODEL = WhisperModel(
                model_name,
                device=str(whisper.get("device", "cpu")),
                compute_type=str(whisper.get("computeType", "int8")),
                download_root=str(model_root),
            )

        temp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(prefix="movie-buddy-", suffix=suffix, delete=False) as temp:
                temp.write(audio)
                temp_path = Path(temp.name)
            language = str(whisper.get("language", "") or "") or None
            initial_prompt = str(whisper.get("initialPrompt", "") or "") or None
            segments, _ = _MODEL.transcribe(
                str(temp_path),
                language=language,
                vad_filter=True,
                beam_size=5,
                initial_prompt=initial_prompt,
            )
            text = "".join(segment.text for segment in segments).strip()
            if not text:
                raise RuntimeError("No clear speech was recognised. Try again a little closer to the microphone.")
            return text
        finally:
            if temp_path:
                # The recording only ever exists as a temp file, and only until
                # the local transcription finishes.
                temp_path.unlink(missing_ok=True)


def build_context(payload: dict) -> dict:
    """Turn one browser 'moment' into the text the backend will receive."""
    movie = str(payload.get("movie", "")).strip()[:300] or prompt("unknownMovie", "unknown film")
    mode = "proactive" if payload.get("mode") == "proactive" else "user"
    timestamp = str(payload.get("timestamp", "00:00:00"))[:20]
    current_subtitle = str(payload.get("currentSubtitle", "")).strip()[:1200]
    recent = payload.get("recentSubtitles", [])
    if not isinstance(recent, list):
        recent = []
    # Hard cap: at most four lines, and only lines the viewer has already heard.
    recent = [str(item).strip()[:800] for item in recent[-4:] if str(item).strip()]

    none_label = prompt("none", "none")
    sep = prompt("labelSeparator", ": ")
    lines = [
        prompt("sceneHeader", "[Movie Buddy · live playback]"),
        f"{prompt('movieLabel', 'Film')}{sep}{movie}",
        f"{prompt('positionLabel', 'Position')}{sep}{timestamp}",
        f"{prompt('currentSubtitleLabel', 'Current subtitle')}{sep}{current_subtitle or none_label}",
    ]
    if recent:
        label = prompt("recentSubtitlesLabel", "Subtitles that just played")
        lines.append(f"{label}{sep.rstrip()}\n" + "\n".join(f"- {line}" for line in recent))
    lines.append(
        prompt(
            "spoilerGuard",
            "Only discuss the current frame and what has already played. "
            "Do not guess, search for, or reveal anything that happens later.",
        )
    )

    if mode == "proactive":
        proactive = PROMPTS.get("proactive")
        if isinstance(proactive, list) and proactive:
            lines.extend(str(item) for item in proactive)
        else:
            lines.append("This is an unprompted check-in. Say something only if this moment is worth it.")
            lines.append("Otherwise reply with exactly [SILENT].")
    else:
        speaker = str(CONFIG.get("userName", "Viewer"))
        lines.append(f"{speaker}{sep}{str(payload.get('text', '')).strip()}")

    return {"text": "\n".join(lines), "mode": mode}


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "MovieBuddy/0.2"
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:
        return

    def guard(self) -> bool:
        """Reject anything that did not come from our own page.

        Without this, any website open in the same browser could POST to this
        port (a JSON body sent as text/plain is not preflighted), and a DNS
        rebinding attack could read the replies back out.
        """
        host = (self.headers.get("Host") or "").lower()
        if host not in ALLOWED_HOSTS:
            self.send_json({"error": "Unexpected Host header."}, HTTPStatus.FORBIDDEN)
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in ALLOWED_ORIGINS:
            self.send_json({"error": "Cross-origin requests are not allowed."}, HTTPStatus.FORBIDDEN)
            return False
        return True

    def send_json(self, payload: object, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def read_body(self, limit: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid Content-Length") from exc
        if length <= 0 or length > limit:
            raise ValueError("The request body was empty or too large")
        return self.rfile.read(length)

    def do_GET(self) -> None:
        if not self.guard():
            return
        route = urlparse(self.path).path

        if route == "/api/state":
            self.send_json(
                {
                    "bridge": read_json(STATUS_FILE, {"status": "starting"}),
                    "response": read_json(RESPONSE_FILE, None),
                }
            )
            return

        if route == "/api/config":
            # Only the parts the page needs. Never the persona or prompt text.
            self.send_json(
                {
                    "userName": CONFIG.get("userName", "You"),
                    "buddyName": CONFIG.get("buddyName", "Buddy"),
                    "appTitle": CONFIG.get("appTitle", "Movie Buddy"),
                    "tagline": CONFIG.get("tagline", ""),
                    "backend": CONFIG.get("backend", "claude"),
                    "capture": CONFIG.get("capture", {}),
                    "ui": {k: v for k, v in CONFIG.get("ui", {}).items() if k != "//"},
                    "proactive": CONFIG.get("proactive", {}),
                    "hardSubtitlePlaceholder": prompt(
                        "hardSubtitlePlaceholder",
                        "[Subtitles are burned into the picture; read them from the current frame]",
                    ),
                }
            )
            return

        relative = "index.html" if route == "/" else route.lstrip("/")
        allowed = {"index.html", "app.js", "styles.css"}
        if relative not in allowed:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        target = ROOT / relative
        try:
            data = target.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.OK)
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
            content_type += "; charset=utf-8"
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        if not self.guard():
            return
        route = urlparse(self.path).path
        try:
            if route == "/api/transcribe":
                audio = self.read_body(MAX_AUDIO_BYTES)
                content_type = (self.headers.get("Content-Type") or "audio/webm").lower()
                suffix = ".ogg" if "ogg" in content_type else ".webm"
                self.send_json({"text": transcribe_audio(audio, suffix)})
                return

            if route == "/api/message":
                payload = json.loads(self.read_body(MAX_FRAME_BYTES + 1024 * 1024).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("Expected a JSON object")
                if not str(payload.get("text", "")).strip():
                    raise ValueError("The message cannot be empty")

                frame_attached = False
                frame_data = str(payload.get("frame", ""))
                if frame_data.startswith("data:image/jpeg;base64,"):
                    raw_frame = base64.b64decode(frame_data.split(",", 1)[1], validate=True)
                    if len(raw_frame) > MAX_FRAME_BYTES:
                        raise ValueError("The captured frame is too large")
                    atomic_write(FRAME_FILE, raw_frame)
                    frame_attached = True

                context = build_context(payload)
                message = {
                    "id": str(uuid.uuid4()),
                    "text": context["text"],
                    "frameAttached": frame_attached,
                    "mode": context["mode"],
                }
                RUNTIME.mkdir(parents=True, exist_ok=True)
                with QUEUE_FILE.open("a", encoding="utf-8", newline="\n") as queue:
                    queue.write(json.dumps(message, ensure_ascii=False) + "\n")
                self.send_json({"ok": True, "id": message["id"], "frameAttached": frame_attached})
                return

            self.send_error(HTTPStatus.NOT_FOUND)
        except (ValueError, RuntimeError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:  # keep the local UI informative
            self.send_json({"error": f"Local service error: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)


def main() -> None:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    write_status("starting")
    start_bridge()
    atexit.register(stop_bridge)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Movie Buddy ({CONFIG.get('backend', 'claude')} backend): {ORIGIN}/", flush=True)
    threading.Timer(0.8, lambda: webbrowser.open(f"{ORIGIN}/")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        stop_bridge()


if __name__ == "__main__":
    main()
