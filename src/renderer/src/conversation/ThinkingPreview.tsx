import { useEffect, useLayoutEffect, useRef } from 'react'
import './thinking-preview.css'

interface ThinkingPreviewProps {
  // 思考缓冲：空字符串表示尚无思考内容，显示占位文案
  reasoning: string
  placeholder: string
  label: string
}

// 等待期思考预览：纯文本渲染，排版后最多三行并跟随最新内容。
// 不使用 aria-live：逐 token 的内容变化不应触发读屏播报，
// 等待状态已由面板头部状态区播报。
export function ThinkingPreview({
  reasoning,
  placeholder,
  label
}: ThinkingPreviewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLSpanElement>(null)

  // 内容增长后保持末尾可见；useLayoutEffect 避免中间帧显示旧位置。
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [reasoning])

  useEffect(() => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return
    // 窗口宽度或字号变化改变折行后同样保持末尾可见
    const observer = new ResizeObserver(() => {
      scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(scroller)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  return (
    <div aria-label={label} className="thinking-preview" role="group">
      {/* 三行裁剪容器：行高与最大高度在 CSS 中成对维护 */}
      <div className="thinking-preview-scroll" ref={scrollRef}>
        <span ref={contentRef}>{reasoning === '' ? placeholder : reasoning}</span>
      </div>
    </div>
  )
}
