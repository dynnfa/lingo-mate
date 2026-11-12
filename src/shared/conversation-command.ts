// ECMAScript whitespace matches the existing conversation input rules. Consume
// one delimiter so significant whitespace in the speech body stays intact.
export function splitConversationCommand(
  text: string
): { command: string; body: string } | undefined {
  const source = text.trimStart()
  const match = /^\/(\S*)(?:\s|$)/u.exec(source)
  return match ? { command: match[1], body: source.slice(match[0].length) } : undefined
}

export const CONVERSATION_TEXT_MAX_CHARS = 4000
