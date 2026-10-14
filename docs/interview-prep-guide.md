# OpenCluely Interview Prep

Run `./setup.sh` once, then launch with `Launch.command` (or `npm start`). The default workspace is a visible interview-preparation tool, not a stealth overlay. ChatGPT subscription authentication is supported; local inference is an explicit alternative. No new API key is required for the ChatGPT path.

## Start a role profile
1. Click **Company contexts +**. Enter a company, date and role preset: startup/business operations, founder's associate, research operations, finance operations, product operations, GTM operations or AI implementation.
2. Paste the job description and your resume text. Keep company statements in notes and untested ideas in hypotheses. Include source URLs. A role description needs its actual duties; a title alone does not establish scope.
3. Save the brief. Each context has a distinct ID, date and practice history. Switching company resets the answer draft. Stop any response/microphone before switching.
4. In **Experience cards**, review the seeded facts, personal contribution, collaborators, implementation approach, evidence, limitations and questions. Confirmed facts and unverified claims are kept separate. Unverified claims are excluded from factual grounding. You can add cards or multiple evidence entries through the advanced JSON editor.
5. Ask a question in **Answer workspace**. Read the direct opening and up to three talking points; expand the spoken answer or technical detail as needed. Review the evidence drawer and missing information before using a draft.

The seeded sample profile (`prep/profile.js`) ships with fictional placeholder data. Replace it with your own facts, experience cards and evidence before using the tool for real practice. Several sample cards intentionally have blank capabilities/contributions — add your own documentation before describing architecture, outcomes or readiness. Education completion is **not verified** by default; edit it accurately, with evidence, if asked. The profile never assumes a completed degree or a seniority level you have not confirmed.

## Practice
**Start / next question** asks one question. Write your own answer, then **Save answer & get feedback**. Local feedback examines specificity, role relevance, clarity and some unsupported-claim patterns. **Practice the follow-up** asks you to substantiate your contribution. **Deeper model critique** and **Review practice & cheat sheet** use the selected provider to produce deeper coaching and a compact review. Practice answers remain unverified and cannot establish personal achievements.

## Providers, streaming and timing
The header selects **ChatGPT subscription** or **Local configured server**. There is no automatic provider switch or paid API fallback. **ChatGPT account** opens the official OAuth panel, including account/model selection. Refresh the workspace status after changing account/model. No browser tokens are extracted; credentials are stored using the OS-level secure storage the sign-in SDK provides.

The local adapter uses your configured loopback URL/model. If no local server is reachable, the app says so rather than falling back silently.

Responses stream as clearly marked **unverified drafts** until formatting/evidence checks complete. **Stop response** cancels generation through the adapter. First-delta and total request times are measured; no guessed token counts or tokens/second are shown. The first-delta measurement includes backend/model-selection time; it is not a tokenizer-level measurement.

## Privacy and permitted assistance
Contexts are stored locally with owner-only file permissions under `.app-data/interview-prep` in a source checkout, or under the OS application-data folder (`userData`) in a packaged build. The model receives a compact candidate summary, up to three relevant cards, selected excerpts from the current company's brief/resume, the question and up to four recent practice turns for that company. It does not receive your whole profile or resume history. Company descriptions, notes, resume and history are treated as untrusted data, never as higher-priority instructions.

Only enable **Permitted live assistance** when interviewer rules allow it and participants consent. Microphone capture requires a separate explicit consent checkbox and **Start microphone**. A visible recording indicator and **Stop microphone** remain available at all times during capture. Transcripts become editable question drafts and are not sent automatically. No automatic screen capture, recording, stealth watcher or concealment feature runs in the default workspace.

Use **Delete this company context**, **Delete practice history** or **Reset profile** for local deletion. Confirmation explains the scope. Context deletion does not disconnect ChatGPT or remove other companies. Deletion is local; data already sent to a provider follows that provider's own retention and deletion controls.

## Grounding limits
Source references and the factuality checks in `prep/engine.js` are guardrails, not proof that every model sentence is true. You still need to compare claims to their excerpts. A pasted notes/JD field can contain multiple URLs; the evidence drawer attaches the first URL found to its combined excerpt. Use one source per notes field where practical, and verify attribution; multiple source links can also be added to personal cards in the JSON editor. Company source material is user-supplied and not independently researched by the app. Unknown outcomes, collaborator details and failure stories stay visible as gaps.

## Image and audio files
Click **Attach image file**, select PNG/JPEG/WebP/GIF, review the preview and ask a question. The selected image is sent through the configured provider only when you click **Draft an answer**. Use **Remove image** to detach it. Files are capped at 10 MB and 6000 pixels per side, kept in memory, and cleared on company switching. Document content is untrusted and cannot establish personal achievements.

Click **Transcribe audio file locally** to select WAV/MP3/M4A/FLAC/OGG/WebM. A local Whisper installation processes it using the cached English model (`WHISPER_MODEL` in `.env`). No microphone is accessed, no model is downloaded automatically, and no persistent server is started. Audio is capped at 12 MB and 120 seconds. The transcript appears in the editable question field; review it and click Draft to send only that text to the model. **Stop response** also cancels file transcription.

The official Sign in with ChatGPT subscription flow does not support direct audio/video input or a transcription API. Direct audio to ChatGPT is therefore not attempted; the supported route is local transcription followed by text inference through the configured provider.

## Build
`npm run build -- --dir --mac --arm64` produces an unsigned build that imports the ChatGPT sign-in SDK from `node_modules/@siwc/local` (set up by `scripts/setup-chatgpt-sdk.sh`) and excludes runtime profile/credential files. A full signed/notarized release was not produced for this fork; use the source launcher (`Launch.command` or `npm start`) for day-to-day use. No Gatekeeper bypass is required when running from source.
