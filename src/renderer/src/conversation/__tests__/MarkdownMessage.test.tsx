// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MarkdownMessage } from '../MarkdownMessage'
import { formatExplorePhraseTable } from '../../../../core/learning/explore-phrase/explore-phrase-table'

afterEach(cleanup)

describe('MarkdownMessage', () => {
  it('renders Markdown and GFM with preserved line breaks', () => {
    const { container } = render(
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
    const { container, rerender } = render(<MarkdownMessage content="" />)
    expect(screen.getByText('…')).toBeInTheDocument()
    rerender(<MarkdownMessage content={'```ts\nconst'} />)
    expect(container.querySelector('pre code')).toHaveTextContent('const')
    rerender(<MarkdownMessage content={'```ts\nconst x = 1\n```\n\n**Done**'} />)
    expect(container.querySelector('strong')).toHaveTextContent('Done')
  })

  it('blocks raw HTML, unsafe links and automatic image requests', () => {
    const { container } = render(
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
    const { container } = render(<MarkdownMessage content={table} />)

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
