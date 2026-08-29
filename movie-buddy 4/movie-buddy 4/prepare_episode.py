"""Create a local timestamped transcript for a movie or episode."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def srt_time(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a local SRT transcript with faster-whisper.")
    parser.add_argument("movie", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    if not args.movie.is_file():
        raise SystemExit(f"No such file: {args.movie}")

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise SystemExit("faster-whisper is not installed. Run: pip install -r requirements.txt") from exc

    model_name = os.environ.get("MOVIE_BUDDY_WHISPER_MODEL", "base")
    configured_root = os.environ.get("MOVIE_BUDDY_MODEL_ROOT", "").strip()
    model_root = Path(configured_root) if configured_root else args.output.parent / ".models"
    model_root.mkdir(parents=True, exist_ok=True)
    print(f"loading model: {model_name}", flush=True)
    model = WhisperModel(model_name, device="cpu", compute_type="int8", download_root=str(model_root))
    segments, info = model.transcribe(
        str(args.movie),
        language=None,
        vad_filter=True,
        beam_size=5,
        condition_on_previous_text=True,
    )

    rows: list[dict[str, object]] = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        rows.append({"start": segment.start, "end": segment.end, "text": text})
        print(f"{srt_time(segment.start)}  {text}", flush=True)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    srt = "\n\n".join(
        f"{index}\n{srt_time(float(row['start']))} --> {srt_time(float(row['end']))}\n{row['text']}"
        for index, row in enumerate(rows, 1)
    )
    args.output.write_text(srt + ("\n" if srt else ""), encoding="utf-8")
    context_path = args.output.with_suffix(".json")
    context_path.write_text(
        json.dumps(
            {
                "source": args.movie.name,
                "language": info.language,
                "language_probability": info.language_probability,
                "segments": rows,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"done: {len(rows)} segments, language={info.language}, output={args.output}", flush=True)


if __name__ == "__main__":
    main()
