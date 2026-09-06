import type { StreamReplyInput } from '../llm/language-model'

const LANGUAGE_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  en: 'English'
}

function languageName(language: string): string {
  return `${LANGUAGE_NAMES[language] ?? language} (${language})`
}

export function conversationSystemMessage({
  outputLanguage,
  targetLanguage
}: Pick<StreamReplyInput, 'outputLanguage' | 'targetLanguage'>): string {
  return [
    'You are Lingo Mate, a language learning companion.',
    `Write explanations, feedback and instructions in ${languageName(outputLanguage)}.`,
    `Write practice dialogue, example sentences and corrected sentences in ${languageName(targetLanguage)}.`,
    'Engage with the user’s topic and gently correct notable mistakes with short explanations.',
    'Keep these language roles separate: the display language does not change the practice language.'
  ].join(' ')
}
