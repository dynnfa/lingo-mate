import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import {
  expect,
  launchApp,
  test,
  waitForReady,
  withTempUserData,
  writeLocalePreference,
  writeModelsConfig
} from './helpers'

type AppWindow = Awaited<ReturnType<ReturnType<typeof launchApp>['firstWindow']>>

// 可控思考流的假模型服务：先延迟一小段（验证占位），再流式输出多段思考
// （中文、英文、显式换行、连续长字符串）。正文在测试调用 release() 之后才
// 输出，保证布局测量期间思考预览持续存在。
async function startReasoningModelServer(): Promise<{
  baseUrl: string
  release(): Promise<void>
  close(): Promise<void>
}> {
  const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
  const chunk = (delta: Record<string, string>): string =>
    sse({ choices: [{ index: 0, delta, finish_reason: null }] })
  const STOP = sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  const reasoningLines = [
    '思考开始：先确认用户输入的意图与上下文。',
    '这是中文思考内容，用于验证中文文本在窄容器中的折行表现，这一段足够长，排版后必然超过三行。',
    'The quick brown fox jumps over the lazy dog while reviewing English grammar patterns in a very long English thought summary line.',
    '显式换行后的第一行\n显式换行后的第二行\n显式换行后的第三行\n显式换行后的第四行超出三行。',
    `连续长字符串不能撑破容器：${'unbroken'.repeat(24)}TAIL_MARKER_最新内容可见`
  ]
  const reply = '这是最终回复，完成后思考区域移除，正文按现有逻辑完整展示，不受三行限制。'

  let releaseStreams!: () => void
  const released = new Promise<void>((resolve) => {
    releaseStreams = resolve
  })
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/release') {
      releaseStreams()
      res.writeHead(200).end('ok')
      return
    }
    void (async () => {
      const chunks: Buffer[] = []
      for await (const part of req) chunks.push(part as Buffer)
      void chunks
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      await new Promise((resolve) => setTimeout(resolve, 500))
      for (const line of reasoningLines) {
        res.write(chunk({ reasoning_content: line }))
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      await released
      res.write(chunk({ content: reply }))
      res.write(STOP)
      res.write('data: [DONE]\n\n')
      res.end()
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    release: async () => {
      await fetch(`http://127.0.0.1:${port}/release`)
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

interface PreviewMetrics {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
  lineHeight: number
  text: string
}

async function previewMetrics(window: AppWindow): Promise<PreviewMetrics | null> {
  return window.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.thinking-preview-scroll')
    if (!scroller) return null
    const lineHeight = parseFloat(getComputedStyle(scroller).lineHeight)
    return {
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      lineHeight,
      text: scroller.textContent ?? ''
    }
  })
}

// 真实浏览器布局断言：可见高度不超过三倍行高，且容器贴底显示最新内容。
// 高度由 CSS 同步保证可立即断言；贴底在 resize/字号变化后由
// ResizeObserver 异步恢复，用轮询等待。
async function expectThreeLineClamp(window: AppWindow): Promise<PreviewMetrics> {
  const current = await previewMetrics(window)
  expect(current).not.toBeNull()
  // 任何状态下都不出现第四行（容忍亚像素取整）
  expect(current!.clientHeight).toBeLessThanOrEqual(current!.lineHeight * 3 + 1.5)
  // 内容已溢出：确实被裁剪而不是内容不足三行
  expect(current!.scrollHeight).toBeGreaterThan(current!.clientHeight)
  // 跟随末尾：最新内容可见
  await expect
    .poll(
      async () => {
        const metrics = await previewMetrics(window)
        return metrics ? metrics.scrollTop + metrics.clientHeight - metrics.scrollHeight : -Infinity
      },
      { timeout: 5_000 }
    )
    .toBeGreaterThanOrEqual(-1.5)
  return (await previewMetrics(window))!
}

test('clamps the thinking preview to three visual lines and follows the tail', async () => {
  await withTempUserData(async (userDataPath) => {
    await writeLocalePreference(userDataPath, 'zh-CN')
    const server = await startReasoningModelServer()
    await writeModelsConfig(userDataPath, server.baseUrl, 'reasoning-model')
    try {
      const app = await launchApp(userDataPath, { model: 'remote' })
      const window = await app.firstWindow()
      await waitForReady(window)

      await window.fill('#message', '你好')
      await window.press('#message', 'Enter')

      // 请求开始后先显示占位；首个思考分片延迟 500ms，占位可被观察到
      await expect(window.locator('.thinking-preview')).toHaveText('正在思考…')

      // 等到末段长字符串思考进入预览后再测量
      await expect
        .poll(async () => (await previewMetrics(window))?.text ?? '', { timeout: 15_000 })
        .toContain('TAIL_MARKER_最新内容可见')

      const metrics = await expectThreeLineClamp(window)
      expect(metrics.text).toContain('这是中文思考内容')
      expect(metrics.text).toContain('The quick brown fox')

      // 窄窗口：折行增多后仍不超过三行并保持末尾可见
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(460, 900)
      })
      await expectThreeLineClamp(window)

      // 字号放大：em 定义的最大高度随行高等比缩放，三行约束不变
      await window.evaluate(() => {
        const preview = document.querySelector<HTMLElement>('.thinking-preview')
        if (preview) preview.style.fontSize = '16px'
      })
      const scaled = await expectThreeLineClamp(window)
      expect(scaled.lineHeight).toBeGreaterThan(metrics.lineHeight)

      // 放行正文：完成后思考区域移除，最终回复完整展示且不被裁剪
      await server.release()
      await expect(window.locator('.status')).toHaveText('回复完成', { timeout: 15_000 })
      await expect(window.locator('.thinking-preview')).toHaveCount(0)
      const replyClipping = await window.evaluate(() => {
        const message = document.querySelector<HTMLElement>('.message.assistant')
        const body = message?.querySelector<HTMLElement>('.markdown-message')
        if (!message || !body) return null
        return {
          containsReply: (body.textContent ?? '').includes('这是最终回复'),
          messageClipped:
            message.scrollHeight > message.clientHeight + 1 ||
            message.scrollWidth > message.clientWidth + 1
        }
      })
      expect(replyClipping).toEqual({ containsReply: true, messageClipped: false })

      await app.close()
    } finally {
      await server.close()
    }
  })
})
