# Realtime Interview Copilot — Architecture Notes

Scope: permitted live interview assistance built on top of the existing Sign in
with ChatGPT / local-model adapters, local Whisper transcription, and the
prep cards/briefs workspace. No automatic or hidden audio capture; live mode
is opt-in and shows a persistent recording indicator.

## Native audio helper (`prep/native/sckit-audio.swift`)

- Captures audio only — no `.screen` output is ever registered, so video
  frames cannot flow through this path.
- Each `CMSampleBuffer` is read with
  `CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer`; its source
  `AVAudioFormat` is taken from `CMSampleBufferGetFormatDescription` and
  converted per source with `AVAudioConverter` (Float32/any → mono Int16
  16000 Hz). Converters persist per source format across callbacks
  (`resetAll()` is called once per stream build, not per callback) to avoid
  resampler artifacts at chunk boundaries.
- Microphone capture uses the macOS 15+ ScreenCaptureKit `.microphone`
  output; if stream start fails with `SCStreamErrorFailedToStartMicrophoneCapture`
  (-3820), the stream is rebuilt system-audio-only and an AVFoundation input
  tap is used as a fallback. Any other failure exits the process rather than
  silently continuing without the mic. Below macOS 15 the helper exits with a
  clear limitation message.
- `config.excludesCurrentProcessAudio = true` so the app's own output is
  never captured.
- Frames are assembled into a single `Data` buffer behind an `NSLock` and
  written with one `write` call.
- `pause` stops the `SCStream` + mic engine and acks `{"paused":true}`;
  `resume` restarts and acks `{"resumed":true}`.
- EOF on stdin always stops capture. Stdin uses a bounded (4 KB tail) line
  accumulator that tolerates split commands. `SCStreamDelegate.didStopWithError`
  tears down and exits non-zero.
- `--self-test` synthesizes sine buffers through both the system and mic
  conversion paths and validates sample count, RMS, channel tags, converter
  reuse and frame layout, both in the checkout and from the packaged,
  unpacked binary (`app.asar.unpacked`).
- `npm run build:native` compiles the helper; `npm run test:native` runs the
  offline self-test. Normal macOS privacy prompts apply; there is no
  Gatekeeper workaround.

## Node capture owner (`prep/native.js`)

- Spawns the helper with a minimal environment (no credentials) and fixed
  argv (no shell interpolation).
- Bounded, sanitized stderr line parser; frame overflow or invalid headers
  terminate the child as a protocol failure instead of silently truncating.
- `startCapture` returns `{ready, stop, pause, resume}`; `ready` resolves
  only on the helper's own `{"ready":true}` announcement.
- Empty `--app` requires an explicit `--allow-system 1` flag; there is no
  silent system-audio fallback (the UI requires selecting an app or
  checking an explicit "all system audio" box with a scope notice).

## Live session (`prep/live-session.js`)

- `start()` sets phase `starting` immediately behind a session
  `AbortController`, so a concurrent Start is rejected and Stop works
  mid-startup. Any failure during startup runs the same full cleanup
  (capture kill, Whisper kill, temp file deletion).
- Transcription is serialized (one request in flight at a time); timeouts
  and responses both advance the queue so nothing hangs.
- `pause()`/`stop()` bump an epoch; any in-flight callback re-checks the
  epoch and phase before emitting, adding context, or dispatching, so a
  superseded capture can never leak into a later session.
- Question detection (`isQuestionCandidate`) requires a trigger phrase at
  the start of an utterance (after filler words) or right after sentence
  punctuation, so embedded clauses inside a longer statement are not
  misread as questions.
- `autoMode=false` never calls the provider automatically: candidates are
  surfaced as `question-pending` for manual review.
- Mic speech is appended to the context as explicitly untrusted dialogue,
  never as a verified accomplishment.
- Provider/model/profile/brief edits are rejected while a live session is
  running.

## Overlay and workspace UI

- The overlay renders incremental opening/talking points with a provisional
  marker during streaming; validated final answers replace them.
- A visible recording indicator and Pause/Resume/Stop controls are shown
  whenever capture is active; there is no stealth or content-protection
  flag on the overlay window.
- The app does not enumerate available apps/windows on launch — only after
  an explicit "Refresh" click — to avoid an unexpected ScreenCaptureKit
  privacy prompt on startup.
- Closing the overlay or the main window awaits a full live-session stop
  (and speech-service stop) before the window is destroyed, so capture
  never continues invisibly.

## Timing and telemetry

Only bounded scalar timings are recorded (VAD last-voiced → STT start/done →
dispatch → first model delta → accepted answer), using a single clock
source. No raw transcripts or audio are retained beyond the bounded
transcription queue. Frame/byte/utterance counters per audio source are
throttled to at most ~2 Hz for the UI.

## Manual QA checklist (native/runtime behavior, requires local consent)

These steps exercise real OS permissions and a live call, so they are not
automated in CI:

1. Launch from source; open the live panel and click "Refresh apps" — the
   app expects a Screen Recording permission grant the first time.
2. With a consented call and headphones on, select the meeting app (or
   check the explicit all-system-audio box and confirm the scope line),
   leave mic off, check the consent box, and click Start. Confirm the live
   indicator, scope line, and that a spoken question produces a provisional
   then validated answer.
3. Turn mic on (separate consent) and confirm mic speech appears as context
   only and never triggers an answer by itself.
4. Pause → confirm audio stops promptly and the label only flips after the
   acknowledgement; Resume → confirm continuation; Stop → confirm the
   indicator turns off and temp files are removed.
5. Deny the mic permission once and confirm a clear remediation message
   with meeting audio unaffected; revoke Screen Recording and confirm a
   clear remediation message with no capture and no mic leak.
6. Quit and relaunch; confirm the selected company and provider persist.
