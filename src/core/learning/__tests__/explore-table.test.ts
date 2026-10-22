import { describe, expect, it } from 'vitest'
import { escapeMarkdownTableCell } from '../explore-table'

describe('escapeMarkdownTableCell', () => {
  it('escapes markdown markers, backslash and html characters', () => {
    expect(escapeMarkdownTableCell('|')).toBe('\\|')
    expect(escapeMarkdownTableCell('\\')).toBe('\\\\')
    expect(escapeMarkdownTableCell('`code`')).toBe('\\`code\\`')
    expect(escapeMarkdownTableCell('*a*_b_~c~[d]')).toBe('\\*a\\*\\_b\\_\\~c\\~\\[d\\]')
    expect(escapeMarkdownTableCell('<img src=x>&')).toBe('&lt;img src=x&gt;&amp;')
    // 句点、冒号、@ 被转义以破坏 GFM 裸 URL、www 前缀与邮箱自动链接。
    expect(escapeMarkdownTableCell('https://example.com')).toBe('https\\://example\\.com')
    expect(escapeMarkdownTableCell('www.example.com')).toBe('www\\.example\\.com')
    expect(escapeMarkdownTableCell('user@example.com')).toBe('user\\@example\\.com')
  })
})
