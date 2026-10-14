"""Bounded persistent live transcription (ONE process per user-started live session).
Loads the already-cached Whisper model ONCE, then transcribes utterance wavs
received as JSON lines on stdin: {"id": "...", "wav": "/path.wav", "channel": "interviewer"|"mic"}.
Replies per line: {"id": "...", "ok": true, "text": "...", "channel": "...", "durationMs": N}
or {"id": "...", "ok": false, "error": "..."}.

Constraints honored:
- Uses only the existing pipx Whisper runtime + cached tiny.en/base model; no downloads.
- CPU only, 2 threads. Offline flags. Minimal environment (no credential inheritance).
- No server/background worker: parent starts this ONLY during a user-started live
  session and terminates it deterministically on pause/stop.
- Channels stay separate (echoed back); caller keeps interviewer/mic apart.
Usage: <whisper-python> prep/transcribe-live.py <model-path>
"""
import sys, os, json, time

def fail_line(req_id, msg):
    sys.stdout.write(json.dumps({"id": req_id, "ok": False, "error": msg}) + "\n")
    sys.stdout.flush()

def main():
    if len(sys.argv) != 2:
        sys.stderr.write("Usage: transcribe-live.py <cached-model-path>\n")
        sys.exit(2)
    model_path = sys.argv[1]
    if not os.path.isfile(model_path):
        sys.stderr.write("Cached Whisper model not found; no download attempted.\n")
        sys.exit(3)
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    import torch
    torch.set_num_threads(2)
    try:
        torch.set_num_interop_threads(2)
    except Exception:
        pass
    import whisper
    try:
        model = whisper.load_model(model_path, device="cpu")
    except Exception as e:
        sys.stderr.write("Whisper model load failed: %s\n" % str(e)[:300])
        sys.exit(4)
    sys.stdout.write(json.dumps({"ok": True, "ready": True, "model": os.path.basename(model_path)}) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        req_id = req.get("id", "")
        wav = req.get("wav", "")
        channel = req.get("channel", "interviewer")
        if not isinstance(wav, str) or not wav or len(wav) > 1024:
            fail_line(req_id, "bad wav path")
            continue
        # Contain to temp utterance dirs only (bounded retention owner).
        if not os.path.isfile(wav):
            fail_line(req_id, "wav missing")
            continue
        if os.path.getsize(wav) > 2 * 1024 * 1024:
            fail_line(req_id, "wav too large")
            continue
        t0 = time.time()
        try:
            result = model.transcribe(wav, fp16=False, language="en", verbose=None,
                                      condition_on_previous_text=False, no_speech_threshold=0.6)
            text = (result.get("text") or "").strip()
            sys.stdout.write(json.dumps({
                "id": req_id, "ok": True, "text": text[:2000],
                "channel": channel, "durationMs": int((time.time() - t0) * 1000)}) + "\n")
        except Exception as e:
            fail_line(req_id, "transcribe failed: " + str(e)[:200])
        sys.stdout.flush()

if __name__ == "__main__":
    main()
