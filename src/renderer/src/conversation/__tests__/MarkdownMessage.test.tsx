// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type { ReactElement } from 'react'
import { createI18n } from '../../i18n'
import { MarkdownMessage } from '../MarkdownMessage'
import { formatExplorePhraseTable } from '../../../../core/learning/explore-phrase/explore-phrase-table'

// 测试语言显式固定为 zh-CN，断言使用真实资源渲染的文本与可访问名称。
const i18n = createI18n('zh-CN')

function renderMessage(element: ReactElement): ReturnType<typeof render> {
  return render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>)
}

afterEach(cleanup)

describe('MarkdownMessage', () => {
  it('renders Markdown and GFM with preserved line breaks', () => {
    const { container } = renderMessage(
      <MarkdownMessage
        content={
          '## Practice\n\n**Hello** and *world*\nNext line\n\n- one\n- two\n\n> quote\n\n`word`\n\n```ts\nconst x = 1\n```\n\n| Word | Meaning |\n| --- | --- |\n| hi | hello |\n\n~~old~~'
        }
      />
    )
    expect(screen.getByRole('heading', { name: 'Practice' })).toBeInTheDocument()
    expect(container.querySelector('strong')).toHaveTextContent('Hello')
    expect(container.querySelector('em')).toHaveTextContent('world')
    expect(container.querySelector('br')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(container.querySelector('blockquote')).toHaveTextContent('quote')
    expect(container.querySelector('pre code')).toHaveTextContent('const x = 1')
    expect(screen.getByRole('table')).toHaveTextContent('Meaning')
    expect(container.querySelector('del')).toHaveTextContent('old')
  })

  it('handles empty and incomplete streaming content then renders the completed content', () => {
    const { container, rerender } = renderMessage(<MarkdownMessage content="" />)
    expect(screen.getByText('…')).toBeInTheDocument()
    rerender(
      <I18nextProvider i18n={i18n}>
        <MarkdownMessage content={'```ts\nconst'} />
      </I18nextProvider>
    )
    expect(container.querySelector('pre code')).toHaveTextContent('const')
    rerender(
      <I18nextProvider i18n={i18n}>
        <MarkdownMessage content={'```ts\nconst x = 1\n```\n\n**Done**'} />
      </I18nextProvider>
    )
    expect(container.querySelector('strong')).toHaveTextContent('Done')
  })

  it('shows a spinner instead of the ellipsis while generating has produced no content yet', () => {
    const { container, rerender } = renderMessage(<MarkdownMessage content="" generating />)
    const spinner = container.querySelector('.message-spinner')
    expect(spinner).toBeInTheDocument()
    expect(spinner).toHaveAttribute('role', 'img')
    expect(spinner).toHaveAttribute('aria-label', '正在生成回复…')
    expect(screen.queryByText('…')).not.toBeInTheDocument()

    rerender(
      <I18nextProvider i18n={i18n}>
        <MarkdownMessage content="Hello" generating />
      </I18nextProvider>
    )
    expect(container.querySelector('.message-spinner')).not.toBeInTheDocument()
    expect(screen.getByText('Hello')).toBeInTheDocument()
  })

  it('blocks raw HTML, unsafe links and automatic image requests', () => {
    const { container } = renderMessage(
      <MarkdownMessage
        content={
          '<script>alert(1)</script>\n\n<img src="https://example.com/track">\n\n[bad](javascript:alert%281%29) [local](file:///tmp/a) [relative](/settings)\n\n![description](https://example.com/image.png)\n\n[reference](https://example.com)'
        }
      />
    )
    expect(container.querySelector('script, img')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com')
    expect(screen.getByRole('link')).toHaveAttribute('target', '_blank')
    expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText('description')).toBeInTheDocument()
  })

  it('renders the explore phrase table with escaped cells as plain text', () => {
    // 真实格式化器输出：包含转义后的管道符、HTML 字符与 Markdown 标记。
    const items = Array.from({ length: 10 }, (_unused, index) => ({
      phrase: index === 0 ? 'a | b' : `phrase ${index}`,
      normalizedPhrase: index === 0 ? 'a | b' : `phrase ${index}`,
      explanation:
        index === 1 ? '含 <b>标签</b>、[链接](http://x) 与 `code` 的释义' : `释义 ${index}`,
      example: index === 2 ? 'A sentence with *stars* & <i>tags</i>.' : `例句 ${index}。`
    }))
    const table = formatExplorePhraseTable(items, {
      index: '序号',
      phrase: '短语',
      meaning: '释义',
      example: '例句'
    })
    const { container } = renderMessage(<MarkdownMessage content={table} />)

    // 语义化表格：四列表头、10 行数据，顺序与字段一一对应。
    const rendered = screen.getByRole('table')
    const headers = rendered.querySelectorAll('thead th')
    expect(headers).toHaveLength(4)
    expect(headers[0]).toHaveTextContent('序号')
    expect(headers[1]).toHaveTextContent('短语')
    expect(headers[2]).toHaveTextContent('释义')
    expect(headers[3]).toHaveTextContent('例句')
    const rows = rendered.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(10)
    expect(rows[0].querySelectorAll('td')[1]).toHaveTextContent('a | b')
    expect(rows[9].querySelectorAll('td')[0]).toHaveTextContent('10')

    // 转义内容按纯文本渲染：不产生链接、图片、注入的 HTML 或额外列。
    expect(container.querySelector('a, img, b, i')).not.toBeInTheDocument()
    expect(rows[1].querySelectorAll('td')).toHaveLength(4)
    expect(rows[1].querySelectorAll('td')[2]).toHaveTextContent('[链接](http://x)')
    // 表格包裹在可横向滚动的容器内，不撑破会话布局。
    expect(rendered.parentElement).toHaveClass('markdown-table')
  })
})
