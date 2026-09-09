import Markdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import './markdown-message.css'

export function MarkdownMessage({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="markdown-message">
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        skipHtml
        components={{
          a: ({ href, children }) =>
            href && /^https?:\/\//i.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          // Do not fetch remote images automatically from conversation content.
          img: ({ alt }) => <span>{alt}</span>,
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          )
        }}
      >
        {content || '…'}
      </Markdown>
    </div>
  )
}
