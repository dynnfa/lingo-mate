// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MarkdownMessage } from '../MarkdownMessage'

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
})
