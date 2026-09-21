import { useTranslation } from 'react-i18next'
import Markdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import './markdown-message.css'

interface MarkdownMessageProps {
  content: string
  // 流式请求已开始：尚无正文增量时显示旋转等待指示而非省略号。
  generating?: boolean
}

export function MarkdownMessage({
  content,
  generating = false
}: MarkdownMessageProps): React.JSX.Element {
  const { t } = useTranslation('conversation')
  return (
    <div className="markdown-message">
      {/* 等待状态已由面板头部状态区播报，这里仅作图形语义，不使用 live region。 */}
      {content === '' && generating ? (
        <span aria-label={t('message.generatingLabel')} className="message-spinner" role="img" />
      ) : (
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
      )}
    </div>
  )
}
