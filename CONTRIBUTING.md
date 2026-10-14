# Contributing

Thanks for considering a contribution.

## Getting started

```bash
git clone https://github.com/zayyanla-hash/opencluely-interview-prep
cd opencluely-interview-prep
npm install
npm test
```

The ChatGPT sign-in SDK is set up separately (it is not an npm dependency —
see the README's "ChatGPT sign-in" section and `patches/README.md`):

```bash
./scripts/setup-chatgpt-sdk.sh
```

You do not need it to run the test suite or to work on most of the
codebase; only the ChatGPT provider path needs it.

## Development

- `npm start` runs the app from source.
- `npm test` runs the test suite (`node --test tests/*.test.js`). Tests
  must not require `@siwc/local` to be present.
- `npm run build:native` builds the optional macOS native audio helper used
  by live/permitted-assistance mode (requires Xcode command line tools).
- Keep changes scoped and add or update tests under `tests/` for behavior
  changes, especially around the factuality/grounding checks in
  `prep/engine.js` and the untrusted-data handling in `prep/store.js` /
  `prep/engine.js`.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Make your change with tests.
3. Run `npm test` and make sure it passes.
4. Open a pull request describing the change and why it's needed.

## Reporting bugs / requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`.

## Security issues

Do not open a public issue for a security vulnerability — see
[SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
