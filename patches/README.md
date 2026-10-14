# Patches

## siwc-local-image-data-url.patch

This patch modifies **OpenAI's "Sign in with ChatGPT Devkit"**
(`https://github.com/openai/sign-in-with-chatgpt-devkit`), specifically
`packages/local/src/responses.ts` and `packages/local/src/types.ts`, on top
of upstream commit `0a36fefeb913055c8c7a1a29b63d82b96b2e841a`.

It adds support for sending `input_image` (data-URL) content alongside
`input_text` in a Responses-API message, so the local ChatGPT adapter can
send a screenshot/attached image along with a text question.

**This patch, and the devkit it modifies, are distributed under the
devkit's own Sign In with ChatGPT Devkit Noncommercial License — not this
repository's Apache-2.0 license.** See the devkit's own `LICENSE` file
(fetched into `.siwc-devkit/LICENSE` by `scripts/setup-chatgpt-sdk.sh`, or
read it directly at
`https://github.com/openai/sign-in-with-chatgpt-devkit/blob/main/LICENSE`)
before using, modifying, or redistributing the patched devkit. In short: it
permits noncommercial, personal use only. The devkit and its patched build
output are intentionally **not** committed to this repository — see
`scripts/setup-chatgpt-sdk.sh`, which clones, patches, and builds it locally
instead.

Applying the patch:

```bash
cd .siwc-devkit
git apply --check ../patches/siwc-local-image-data-url.patch   # verify it's not already applied
git apply ../patches/siwc-local-image-data-url.patch
```

`scripts/setup-chatgpt-sdk.sh` does this for you, idempotently.
