# Lingo Mate

Lingo Mate is a desktop language-learning agent designed to help people learn with as few tokens as possible. At a time when token costs can make regular AI-assisted learning expensive, Lingo Mate aims to spend your budget only where a language model adds real value: understanding language, explaining concepts, and giving personalized feedback.

To reduce unnecessary model calls, Lingo Mate turns vocabulary collection, content management, and practice into dedicated workflows. Analyzed learning material is stored locally for reuse, duplicate and previously saved words are not analyzed again, and vocabulary exercises draw questions from the local library before calling the model only when an answer needs review. You can also choose your own model and track actual token consumption in the usage dashboard.

## Features

Lingo Mate currently supports learning English, with an interface available in Simplified Chinese and English.

- **Learning conversations:** Practice expression, rewrite sentences, and ask language questions. Multiple sessions, conversation history, streaming responses, cancellation, and retry are supported.
- **Vocabulary and phrase collection:** Use `/vocabulary` and `/phrase` to save learning material. The model generates pronunciation, meanings, concept explanations, and examples for words, or explanations and examples for phrases. Saved entries can be reviewed and deleted from dedicated pages.
- **Phrase exploration:** Use `/explore-phrase` to generate ten common English phrases with meanings and examples, shown as a table in the conversation. The last seven rounds are deduplicated through a local history file, so new rounds always bring fresh phrases.
- **Synonym comparison:** Use `/synonym` to organize related words and save their meanings and usage distinctions for later comparison.
- **Vocabulary practice and mistake tracking:** Draw a chosen number of random words from the local library, enter their meanings, and submit answers for model review. Incorrect answers are automatically collected, with error counts, recent mistakes, and answer history available for review.
- **Sentence practice:** Draw three words from the vocabulary library and receive model-generated phrase hints. Submit a sentence for feedback on word usage, fluency, and grammar, together with a suggested revision.
- **Vocabulary import and export:** Add batches of words for AI-assisted analysis, import existing learning material with an Excel template, and export the vocabulary library. Imports detect duplicate content.
- **Bring your own model:** Configure OpenAI-compatible or Gemini endpoints with a Base URL, Model ID, and API key. Save and switch between multiple configurations and test their connections.
- **Token usage statistics:** Review today's and this week's input, output, and total token usage and request counts. Charts show trends for the last 30 days and eight weeks. Completeness depends on the usage data returned by the model provider.

The app is built with Electron, React, and TypeScript, and stores conversations and learning records locally in SQLite. An optional Python / LangGraph subprocess handles in-memory Agent orchestration for ordinary conversations and `/concept`; domain logic, model requests, credentials, storage, and usage accounting remain in the TypeScript host. TypeScript is the default execution path. See the [Agent architecture decision](docs/adr/2026-10-21-python-langgraph-agent-engine.md).

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

Run the following commands from the repository root. Development and validation require pnpm, Node.js 22.6+, uv, and Python 3.13.3, as pinned in `agent-engine/.python-version`. Full tests and desktop packaging use the Python environment even when the optional runtime is disabled.

### Install

```bash
$ pnpm install
$ pnpm agent:sync
```

### Development

```bash
$ pnpm dev
```

To enable the internal Python pilot on macOS or Linux:

```bash
$ LINGO_MATE_AGENT_RUNTIME=python pnpm dev
```

In PowerShell, set `$env:LINGO_MATE_AGENT_RUNTIME='python'` before running `pnpm dev`. Once enabled, startup, protocol, or execution failures return an error without silently falling back or replaying the failed request. See the [Agent Engine guide](agent-engine/README.md) for environment setup and troubleshooting.

### Validation

After syncing the locked Python environment, run checks appropriate to the change:

```bash
$ pnpm lint
$ pnpm typecheck
$ pnpm test
$ pnpm build
```

Python or protocol changes also require `pnpm agent:protocol`, `pnpm agent:test`, and `pnpm agent:check`. Electron behavior changes require `pnpm test:electron`, which builds both the desktop code and the Python runtime before running end-to-end tests. Runtime packaging changes also require `pnpm agent:build` and `pnpm agent:smoke`; see the [Agent Engine guide](agent-engine/README.md) for installation-layout checks.

### Build

Desktop packaging builds a native PyInstaller runtime, so run each command on the target OS and CPU architecture after `pnpm agent:sync`. Packaged applications do not require users to install Python or uv. `pnpm build` alone builds the TypeScript application and does not produce the Python runtime or an installer.

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```
