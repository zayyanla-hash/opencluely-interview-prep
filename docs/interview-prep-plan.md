# Interview Prep implementation plan

Goal: grounded, concise interview practice and permitted live assistance inside a visible Electron workspace.

Architecture: a normal visible Electron workspace; a validated local profile and per-company brief store; compact retrieval and a trusted system prompt; ChatGPT/local provider adapters with cancellation; an evidence drawer and measured response latency. No model training, concealment or automatic audio capture.

- [x] Baseline snapshot and read-only review of the existing codebase before changes.
- [x] Write factuality, retrieval, company-isolation, injection and provider tests before implementation.
- [x] Implement profile seed, local store, retrieval/prompt engine and provider orchestration.
- [x] Add accessible workspace, evidence drawer, role briefs, practice/critique/review, explicit consent/audio controls.
- [x] Preserve manual provider selection and the official encrypted OAuth flow; add cancellation without silent provider fallback.
- [x] Run the test suite, verify the build, and confirm provider streaming/cancellation end to end.
- [x] Document changed files, privacy behavior, role selection and rollback.

Alternatives considered: editing the original DSA-only prompt in place risks carrying over unrelated session context; a second app install would conflict with keeping a single checkout. A new workspace module was added inside the existing checkout instead, with the legacy source retained for rollback. The default app does not launch the original stealth overlay or screen-share watchers.
