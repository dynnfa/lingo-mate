# Lingo Mate

Lingo Mate is a desktop language-learning agent designed to help people learn with as few tokens as possible. At a time when token costs can make regular AI-assisted learning expensive, Lingo Mate aims to spend your budget only where a language model adds real value: understanding language, explaining concepts, and giving personalized feedback.

To reduce unnecessary model calls, Lingo Mate turns vocabulary collection, content management, and practice into dedicated workflows. Analyzed learning material is stored locally for reuse, duplicate and previously saved words are not analyzed again, and vocabulary exercises draw questions from the local library before calling the model only when an answer needs review. You can also choose your own model and track actual token consumption in the usage dashboard.

## Features

Lingo Mate currently supports learning English, with an interface available in Simplified Chinese and English.

- **Learning conversations:** Practice expression, rewrite sentences, and ask language questions. Multiple sessions, conversation history, streaming responses, cancellation, and retry are supported.
- **Vocabulary and phrase collection:** Use `/vocabulary` and `/phrase` to save learning material. The model generates pronunciation, meanings, concept explanations, and examples for words, or explanations and examples for phrases. Saved entries can be reviewed and deleted from dedicated pages.
- **Synonym comparison:** Use `/synonym` to organize related words and save their meanings and usage distinctions for later comparison.
- **Vocabulary practice and mistake tracking:** Draw a chosen number of random words from the local library, enter their meanings, and submit answers for model review. Incorrect answers are automatically collected, with error counts, recent mistakes, and answer history available for review.
- **Sentence practice:** Draw three words from the vocabulary library and receive model-generated phrase hints. Submit a sentence for feedback on word usage, fluency, and grammar, together with a suggested revision.
- **Vocabulary import and export:** Add batches of words for AI-assisted analysis, import existing learning material with an Excel template, and export the vocabulary library. Imports detect duplicate content.
- **Bring your own model:** Configure OpenAI-compatible or Gemini endpoints with a Base URL, Model ID, and API key. Save and switch between multiple configurations and test their connections.
- **Token usage statistics:** Review today's and this week's input, output, and total token usage and request counts. Charts show trends for the last 30 days and eight weeks. Completeness depends on the usage data returned by the model provider.

The app is built with Electron, React, and TypeScript, and stores conversations and learning records locally in SQLite.

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```
