# Lingo Mate

English | [简体中文](README.zh-CN.md)

A desktop language-learning assistant that connects AI conversations, vocabulary and expression collection, practice, and mistake review. Lingo Mate aims to help people with different native languages learn their chosen target language. Keep your learning records locally, connect your own model service, and track token usage.

Lingo Mate turns material you collect into material you can practice. Saved analyses are reused, duplicate entries are skipped, and practice questions are drawn from your local vocabulary library to reduce unnecessary model calls.

## Features

The product is designed to grow into a general language-learning assistant. **The current version supports English as its target learning language**, with an **English and Simplified Chinese** interface. Support for additional learning languages requires changes to prompts, validation, storage, practice, and speech; changing the interface language does not add a learning language. See the [language-learning scope and design principles](docs/language-learning-scope.md).

- **Learn through conversation.** Ask language questions, polish sentences, or use `/concept` for explanations. Conversations support history, streaming responses, cancellation, and explicit retry.
- **Build a personal library.** Save words with `/vocabulary` and phrases with `/phrase`, including explanations and examples. Use `/synonym` to compare related words and their usage.
- **Discover new material.** `/explore-vocabulary` and `/explore-phrase` each generate ten items with meanings and examples. Each workflow checks against its own last seven batches to reduce repetition.
- **Practice what you collect.** Review meanings with vocabulary exercises and automatic mistake tracking. Sentence practice draws three saved words, offers phrase hints, and gives feedback on usage, fluency, and grammar.
- **Listen locally.** Read saved vocabulary, phrases, and English examples aloud, or use `/tts` to generate speech in a conversation. Local speech supports pause, resume, stop, and seeking.
- **Import and export vocabulary.** Analyze batches of new words, import existing material using an Excel template, and export your library. Imports detect duplicates.
- **Choose your model and monitor usage.** Save and switch between OpenAI-compatible or Gemini configurations. Review token counts, request counts, and daily and weekly trends when usage data is supplied by the provider.

## A learning session

The following English examples demonstrate the workflows available in the current version.

1. Ask a question or explore a concept: `/concept present perfect`.
2. Save words you want to learn: `/vocabulary adapt, adopt, adept`.
3. Open **Recorded vocabulary** to review their meanings and examples.
4. Open **Start practicing** for vocabulary or sentence exercises.
5. Return to the **Mistake book** to review incorrect vocabulary answers.

You can also save a phrase with `/phrase break the ice` or discover a new batch with `/explore-phrase`.

## Getting started

For now, use the source setup below. This README does not yet provide a prebuilt installer download.

### Run from source

Install these prerequisites first:

- **Node.js 22.12+** (22.x line recommended) — required by the current Vite / Electron Vite toolchain; see the [installation notes](#installation-notes) below.
- **pnpm (10+)** — JavaScript dependency management.
- **uv** — Python environment management.
- **Python 3.13.3** — pinned in `agent-engine/.python-version`; `uv` manages the project environment.

From the repository root, run:

```sh
pnpm install
pnpm agent:sync
pnpm dev
```

#### Installation notes

- **Prefer Node 22 (22.12+).** It is the line this toolchain is validated on; `.nvmrc` pins it for nvm/fnm users. Node 24.16+/26.1+ changed core stream behavior so `yauzl@2` — used by Electron's binary installer — stalls mid-extraction: `pnpm install` ends without the Electron binary and `pnpm dev` then fails with `Error: Electron uninstall`. The `yauzl` override in `pnpm-workspace.yaml` repairs the installer on those lines (verified on Node 26); other toolchain stages are still only validated on Node 22.
- **Dependency build-script approvals live in `pnpm-workspace.yaml`.** pnpm 10 and newer no longer read the `pnpm` field in `package.json`. `electron` and `esbuild` must run their install scripts; their approvals (and explicit refusals for packages that ship prebuilt artifacts) are declared there. Update that file when adding dependencies with build scripts.
- **Verify the Electron binary after installing.** `node_modules/electron/path.txt` should exist. If it is missing, run `pnpm rebuild electron` with Node 22 active.
- **Slow or blocked downloads.** If the Electron binary download is slow, set a mirror in `~/.npmrc`, for example `electron_mirror=https://npmmirror.com/mirrors/electron/`.

Development startup uses persistent application data. Use a separate test user-data directory when validating changes; see the [contribution notes](#contributing).

### Connect a model

1. Open **Settings → Models → Add model**.
2. Select the API type, then enter your service's Base URL, Model ID, and API key if required.
3. Use **Test draft**, save the configuration, and select it as the **Current model**.
4. Start a conversation and try one of the examples above.

| Field    | What to enter                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API type | `OpenAI-compatible` or `Gemini`, matching your service's protocol                                                                                                  |
| Base URL | The API root supplied by your service, including any required version path; for example, `https://api.example.com/v1` is an illustrative OpenAI-compatible address |
| Model ID | The exact model identifier accepted by that endpoint                                                                                                               |
| API key  | Your service credential; local endpoints that do not require authentication can leave this empty                                                                   |

Remote endpoints require HTTPS; HTTP is allowed for loopback addresses such as `localhost`. Model configuration is done in the app; an `.env` file is not required.

Vocabulary and phrase analysis, exploration, synonym comparison, and vocabulary answer review require tool/function calling support. A successful connection test confirms a minimal text request works; it does not certify every learning workflow. Compatibility depends on both the endpoint and the selected model.

Model requests, including connection tests, may incur charges from your chosen service. Usage statistics depend on the provider's returned data and are not a billing statement.

### Enable local speech

Open **Settings → Speech** and install the speech resources, a download of approximately **327 MB**. After installation, speech synthesis runs locally and does not require an LLM configuration. See the [speech runtime guide](docs/speech-runtime.md) for resource details and validation limits.

### Platform status

The repository includes macOS, Windows, and Linux packaging commands. Documented runtime validation is on **macOS arm64**; other OS/CPU combinations and release signing still require validation in their respective release environments. Packaging configuration alone does not establish platform support. See the [Agent Engine guide](agent-engine/README.md) for the recorded scope.

## Data and privacy

- **Local records:** Conversations, saved learning entries, vocabulary mistakes, and conversation audio are stored in local SQLite. Model settings and exploration histories are stored in separate local files under the application's user-data directory.
- **Model requests:** AI features send the input and task context they need, such as conversation history, vocabulary, or practice answers, to the endpoint you configure. Local storage does not make these requests offline; data handling at that endpoint depends on the service you choose.
- **Credentials:** Saved API keys are encrypted through Electron's `safeStorage`. The interface receives a masked preview rather than a stored plaintext key.
- **Speech resources:** Initial installation downloads model resources from Hugging Face. Subsequent speech synthesis runs locally.
- **Diagnostics:** Local error logs redact credentials, but failure diagnostics can contain learning text or raw model responses. Review logs before sharing them. See the [logging guide](docs/error-logging.md).

## Development

### Architecture

```text
React UI → Preload API → Electron Main → TypeScript host / SQLite
                                      ↔ Python / LangGraph
```

Python owns Agent task routing, prompts, and workflow orchestration for conversations, titles, vocabulary, phrases, synonyms, exploration, sentence practice, vocabulary answer review, and `/tts`. TypeScript owns model transport, credentials, domain validation, persistence, and desktop capabilities. Engine failures surface explicitly without silent fallback or automatic replay.

For implementation details, read the [architecture guide](docs/architecture.md), [Agent Engine guide](agent-engine/README.md), and [project conventions](AGENTS.md).

### Validation

Sync the locked Python environment before running the full TypeScript suite, which includes real Python-pipe integration tests:

```sh
pnpm agent:sync
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Python, protocol, or host integration changes also require:

```sh
pnpm agent:protocol
pnpm agent:test
pnpm agent:check
```

For protocol changes, follow the schema-generation instructions in the [Agent Engine guide](agent-engine/README.md). Runtime packaging changes additionally require `pnpm agent:build` and `pnpm agent:smoke`.

Electron E2E tests require explicit user permission before execution under the project conventions. Once authorized, run `pnpm test:electron`; it builds the desktop code and Python runtime before running the tests. Speech validation has additional resource requirements described in the [speech runtime guide](docs/speech-runtime.md).

### Packaging

Run packaging commands on the target OS and CPU architecture after `pnpm agent:sync`:

```sh
pnpm build:mac
pnpm build:win
pnpm build:linux
```

Each command builds a native PyInstaller runtime. Packaged applications do not require users to install Python or uv. `pnpm build` alone builds the TypeScript application; it does not create the Python runtime or an installer. Installation-layout checks, signing requirements, and platform limits are documented in the [Agent Engine guide](agent-engine/README.md).

## Contributing

Bug reports, feature suggestions, documentation improvements, and focused pull requests are welcome through this repository's Issues and pull requests.

- For bugs, include the OS/CPU, app version or commit, reproduction steps, and expected and actual behavior. Remove credentials and private learning content from any attachments.
- For larger changes, describe the proposed behavior in an issue before starting implementation.
- Read [AGENTS.md](AGENTS.md) for architecture boundaries, internationalization, testing, and code organization. New Agent strategies and workflows belong in `agent-engine/`.
- Add regression tests for reproducible bugs and use test-driven development for business logic, state transitions, and security boundaries. Run the checks relevant to your change and report the results in your pull request.
- Use disposable data for validation. Obtain explicit user permission before migrating or changing a real user's database, and before running any E2E tests.

## License

A project license has not yet been selected, and this repository currently has no project-level `LICENSE` file. Licensing needs to be finalized before the open-source release. Third-party speech resource notices are recorded separately in [NOTICE.txt](resources/speech/headtts/NOTICE.txt).
