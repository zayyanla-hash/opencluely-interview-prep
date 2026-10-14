# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for a security vulnerability.

Instead, use GitHub's private vulnerability reporting for this repository:
go to the **Security** tab → **Advisories** → **Report a vulnerability**.
This opens a private channel with the maintainers so the issue can be
discussed and fixed before it's public.

If private reporting isn't available for some reason, open an issue asking
a maintainer to enable it or to provide another private channel — without
including vulnerability details in the issue itself.

## Scope

This repository ships:

- An Electron desktop app (local-first; profile and company-context data
  stored under `.app-data/` or the OS `userData` folder).
- Adapters for a user's own ChatGPT subscription (via OpenAI's Sign in
  with ChatGPT Devkit, set up locally — see `scripts/setup-chatgpt-sdk.sh`)
  and for a user-configured local model server.
- Optional local Whisper-based speech transcription.

Please report issues such as: credential handling bugs, path
traversal/sandbox escapes in file handling (profile store, uploaded
images/audio, native audio helper), prompt-injection paths that bypass the
untrusted-data boundaries in `prep/engine.js` / `prep/store.js`, or anything
that could exfiltrate stored profile/company data or OAuth tokens.

## Supported Versions

Only the latest `main` branch is actively supported.
