"""Bounded, offline file transcription using an already-cached Whisper model. No microphone."""
import sys, json, subprocess, contextlib, io, os
try:
    audio, model = sys.argv[1:3]
    if not os.path.isfile(audio) or not os.path.isfile(model):
        raise ValueError('missing file')
    probe = subprocess.run(['/opt/homebrew/bin/ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', audio], capture_output=True, text=True, timeout=10, check=True)
    duration = float(json.loads(probe.stdout)['format']['duration'])
    if not 0 < duration <= 120:
        raise ValueError('duration limit')
    with contextlib.redirect_stdout(io.StringIO()):
        import torch, whisper
        torch.set_num_threads(2)
        recognizer = whisper.load_model(model, device='cpu')
        result = recognizer.transcribe(audio, fp16=False, language='en', verbose=None, condition_on_previous_text=False)
    print(json.dumps({'text': result['text'].strip(), 'durationSeconds': duration}))
except Exception:
    print('File transcription unavailable.', file=sys.stderr)
    sys.exit(1)
