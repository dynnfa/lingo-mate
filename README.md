# Lingo Mate

English | [简体中文](README.zh-CN.md)

A desktop AI agent for language learning. Ask about an expression you came across, save words and sentences you want to remember, and practice with your own vocabulary library. Your learning records are stored locally, and you choose the model service.

**Currently supports learning English**, with a **Simplified Chinese or English** interface. See the [language-learning scope](docs/language-learning-scope.md) for the project's approach to adding more languages.

## A learning session

1. **Ask in your own words.** Try “How do I use ‘keep me posted’?” The desktop agent can recognize requests about the meaning or usage of an expression and explain how it works in context. You can also select the explanation explicitly with `/concept keep me posted`.
2. **Save material for later.** Send `/phrase keep me posted` to save the phrase with an explanation and examples. Send `/sentence 如果计划有变，记得告诉我。` to translate the text into natural English and save both versions. Find them under **Recorded vocabulary → Phrases** or **Sentences**.
3. **Practice with your vocabulary.** Add a few words with `/vocabulary keep, update, change`, then open **Start practicing**. Recall word meanings, or write a sentence using three words drawn from your library. Sentence practice offers phrase hints and feedback on usage, fluency, and grammar.
4. **Review your mistakes.** Incorrect vocabulary answers are collected in the **Mistake book**.

Desktop conversations have saved history, streaming replies, cancellation, and manual retry.

## Getting started

### Run from source

Use **Node.js 22.x (22.12 or later)**, **pnpm 10 or later**, and **uv**. The Agent Engine pins Python 3.13.3, which `uv` uses to create the project environment.

From the repository root, run:

```sh
pnpm install
pnpm agent:sync
pnpm dev
```

<details>
<summary>Installation notes</summary>

- `.nvmrc` selects Node 22 for nvm and fnm users. If `node_modules/electron/path.txt` is missing after installation, run `pnpm rebuild electron` with Node 22 active.
- Dependency build-script approvals, including those required by Electron and esbuild, are in [pnpm-workspace.yaml](pnpm-workspace.yaml).
- For slow Electron downloads, you can set an `electron_mirror` in `~/.npmrc`.

</details>

The Agent runtime has been validated on **macOS arm64**. Windows, Linux, other CPU architectures, and release signing require separate validation. See the [Agent Engine guide](agent-engine/README.md).

### Connect a model

1. Open **Settings → Models → Add model**.
2. Select **OpenAI-compatible** or **Gemini**. Enter the service's Base URL, including any version path, its Model ID, and an API key if required.
3. Use **Test draft**, save the configuration, and select it as the **Current model**.
4. Start a conversation and try one of the examples above.

Remote endpoints require HTTPS. Loopback addresses such as `localhost` can use HTTP. **Test draft** checks a minimal text request. Vocabulary and phrase analysis, exploration, synonym analysis, and vocabulary answer review also require tool calling support. Model calls may incur provider charges. **Settings → Usage** shows recorded requests and token counts when the provider returns them.

### Enable local speech

Install the approximately **327 MB** resource bundle from **Settings → Speech**. You can then listen to saved words, phrases, or English examples, or generate replayable audio with `/tts`. Speech synthesis runs locally and works independently of the model service. See the [speech runtime guide](docs/speech-runtime.md).

## Desktop commands

Type a command in the conversation or pick an action from the `/` menu. Use a collection command when you want to add material to your library.

| Try it                                       | What it does                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/concept keep me posted`                    | Explain the core idea and usage of a word or expression in chat.                                         |
| `/vocabulary keep, update, change`           | Analyze and save words with meanings, core concepts, and examples.                                       |
| `/phrase break the ice`                      | Analyze and save phrases or idioms. Enter one phrase per line for a batch.                               |
| `/synonym adequate, decent`                  | Analyze and save groups of related words with differences in meaning and usage.                          |
| `/sentence I look forward to hear from you.` | Polish English text or translate a passage into English, then save the original and the result together. |
| `/explore-vocabulary`                        | Discover 10 English words with meanings and examples.                                                    |
| `/explore-phrase`                            | Discover 10 English phrases with meanings and examples.                                                  |
| `/tts Please keep me posted.`                | Synthesize English speech locally and replay it from the conversation.                                   |

Each exploration command checks its own last seven batches to avoid repeats. In **Recorded vocabulary → Vocabulary**, you can also import entries with an Excel template or export your word library.

## Telegram and QQ private chats

Use a bound Telegram or QQ bot for text conversations and `/sentence` collection while the desktop app is running. Send `/help` in the private chat to see the available commands.

1. In **Settings → Channels → Add channel**, enter a Telegram bot token or a QQ bot AppID and AppSecret. QQ requires WebSocket and direct-message access in the QQ Open Platform.
2. Test the connection and start the channel. Copy the binding command from the channel card, generating a code if needed.
3. Send `/bind <code>` to the bot in a private chat, then confirm the account in the desktop app.

Channel integration tests use simulated platform connections. Live-platform acceptance testing is pending. See the [channel guide](docs/communication-adapters.md).

## Data and privacy

- **Local records.** Conversations, saved entries, vocabulary mistakes, and conversation audio are stored in SQLite. Model settings and exploration histories are stored in local files.
- **External services.** AI workflows send the input and relevant context to the model endpoint you configure. Bot messages pass through Telegram or QQ when you enable a channel. The initial speech resource download comes from Hugging Face.
- **Credentials.** Saved API keys and bot credentials are encrypted through Electron's `safeStorage`.
- **Diagnostics.** Local error logs redact credentials and may include learning text or raw model responses. Review logs before sharing them. See the [logging guide](docs/error-logging.md).

## Development

### Architecture

```text
React UI → Preload API → Electron Main → TypeScript host / SQLite
                                      ↔ Python / LangGraph
```

The Python/LangGraph Agent Engine routes conversation requests and owns the prompts and workflows for chat, the desktop commands, title generation, sentence practice, and vocabulary answer review. The TypeScript host handles model requests, credentials, validation, storage, speech, and bot connections.

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

Each packaging command includes a native PyInstaller runtime so users can run the app without installing Python or uv. Use `pnpm build` to build the TypeScript application on its own. See the [Agent Engine guide](agent-engine/README.md) for installation-layout checks, signing requirements, and platform limits.

## Contributing

Bug reports, feature suggestions, documentation improvements, and focused pull requests are welcome through this repository's Issues and pull requests.

- For bugs, include the OS/CPU, app version or commit, reproduction steps, and expected and actual behavior. Remove credentials and private learning content from any attachments.
- For larger changes, describe the proposed behavior in an issue before starting implementation.
- Read [AGENTS.md](AGENTS.md) for architecture boundaries, internationalization, testing, and code organization. New Agent strategies and workflows belong in `agent-engine/`.
- Add regression tests for reproducible bugs and use test-driven development for business logic, state transitions, and security boundaries. Run the checks relevant to your change and report the results in your pull request.
- Use disposable data for validation. Obtain explicit user permission before migrating or changing a real user's database, and before running any E2E tests.

## License

Project licensing is pending. Third-party speech resource notices are in [NOTICE.txt](resources/speech/headtts/NOTICE.txt).
