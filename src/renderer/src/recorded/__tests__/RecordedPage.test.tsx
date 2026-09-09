// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { I18nextProvider } from 'react-i18next'
import type { VocabularyApi } from '../../../../shared/vocabulary'
import type { PhraseApi } from '../../../../shared/phrase'
import type { SynonymApi } from '../../../../shared/synonym'
import { createI18n } from '../../i18n'
import { RecordedPage } from '../RecordedPage'

// 组件测试固定 zh-CN 渲染，英文用例内切换语言；断言基于真实资源文本。
const i18n = createI18n('zh-CN')

// 已记录页右侧按菜单渲染详情；提供稳定空结果桩避免列表读取挂起。
const emptyVocabularyApi: VocabularyApi = {
  async list() {
    return { status: 'ok', entries: [] }
  },
  async delete() {
    return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
  }
}

const emptyPhraseApi: PhraseApi = {
  async list() {
    return { status: 'ok', entries: [] }
  },
  async delete() {
    return { status: 'error', error: { code: 'UNKNOWN_ERROR' } }
  }
}

const emptySynonymApi: SynonymApi = {
  async list() {
    return { status: 'ok', groups: [], nextCursor: null }
  }
}

const entry = {
  id: '11111111-1111-4111-8111-111111111111',
  term: 'apple',
  phonetic: '/ˈæpəl/',
  meaning: '苹果，一种水果。',
  concept: '苹果果实。',
  exampleSentences: ['I ate an apple after lunch.'],
  createdAt: '2026-09-07T00:00:00.000Z'
}

const phraseEntry = {
  phrase: 'look forward to',
  explantation: '期待，盼望（某件将发生的事）。',
  example: 'I look forward to hearing from you.'
}

function renderPage(onExit: () => void = vi.fn()): () => void {
  vi.stubGlobal('api', {
    vocabulary: emptyVocabularyApi,
    phrase: emptyPhraseApi,
    synonym: emptySynonymApi
  })
  render(
    <I18nextProvider i18n={i18n}>
      <RecordedPage onExit={onExit} />
    </I18nextProvider>
  )
  return onExit
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  void i18n.changeLanguage('zh-CN')
})

describe('RecordedPage', () => {
  it('renders the vocabulary, phrase and synonym menu items with vocabulary selected by default', () => {
    renderPage()

    const menu = screen.getByRole('navigation', { name: '已记录词汇菜单' })
    const items = within(menu).getAllByRole('button')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('词汇')
    expect(items[1]).toHaveTextContent('短语')
    expect(items[2]).toHaveTextContent('近义词')
    expect(items[0]).toHaveAttribute('aria-current', 'true')
    expect(items[1]).not.toHaveAttribute('aria-current')
    expect(items[2]).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('main', { name: '已记录词汇' })).toBeInTheDocument()
  })

  it('renders the vocabulary detail inside the right content container', async () => {
    renderPage()

    const detail = document.querySelector('.recorded-detail')
    expect(detail).toBeInstanceOf(HTMLElement)
    expect(detail).toContainElement(await screen.findByRole('heading', { name: '词汇' }))
    expect(screen.queryByRole('heading', { name: '短语' })).not.toBeInTheDocument()
  })

  it('switches the detail by menu and reloads after leaving a section', async () => {
    const phraseCalls = { list: 0 }
    vi.stubGlobal('api', {
      vocabulary: emptyVocabularyApi,
      phrase: {
        ...emptyPhraseApi,
        async list() {
          phraseCalls.list += 1
          return { status: 'ok', entries: [phraseEntry] }
        }
      },
      synonym: emptySynonymApi
    })
    render(
      <I18nextProvider i18n={i18n}>
        <RecordedPage onExit={vi.fn()} />
      </I18nextProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: '短语' }))
    expect(await screen.findByRole('heading', { name: '短语' })).toBeInTheDocument()
    expect(await screen.findByText('look forward to')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '词汇' })).not.toBeInTheDocument()
    expect(phraseCalls.list).toBe(1)

    // 切回词汇：短语视图卸载，重新进入短语时再次读取最新列表。
    fireEvent.click(screen.getByRole('button', { name: '词汇' }))
    expect(await screen.findByRole('heading', { name: '词汇' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '短语' }))
    expect(await screen.findByRole('heading', { name: '短语' })).toBeInTheDocument()
    expect(phraseCalls.list).toBe(2)
  })

  it('switches to the synonym detail and reloads on re-entry', async () => {
    const synonymCalls = { list: 0 }
    vi.stubGlobal('api', {
      vocabulary: emptyVocabularyApi,
      phrase: emptyPhraseApi,
      synonym: {
        ...emptySynonymApi,
        async list() {
          synonymCalls.list += 1
          return {
            status: 'ok',
            groups: [
              {
                id: '22222222-2222-4222-8222-222222222222',
                meaning: '足够好',
                words: [
                  {
                    id: '33333333-3333-4333-8333-333333333333',
                    word: 'sufficient',
                    meaning: '足够的',
                    distinction: '数量上足够',
                    groupid: '22222222-2222-4222-8222-222222222222'
                  }
                ]
              }
            ],
            nextCursor: null
          }
        }
      }
    })
    render(
      <I18nextProvider i18n={i18n}>
        <RecordedPage onExit={vi.fn()} />
      </I18nextProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: '近义词' }))
    expect(await screen.findByRole('heading', { name: '近义词' })).toBeInTheDocument()
    expect(await screen.findByText('sufficient')).toBeInTheDocument()
    expect(screen.getByText('足够好')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '词汇' })).not.toBeInTheDocument()
    expect(synonymCalls.list).toBe(1)

    // 切回词汇：近义词视图卸载，重新进入时再次读取最新分组。
    fireEvent.click(screen.getByRole('button', { name: '词汇' }))
    expect(await screen.findByRole('heading', { name: '词汇' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '近义词' }))
    expect(await screen.findByText('sufficient')).toBeInTheDocument()
    expect(synonymCalls.list).toBe(2)
  })

  it('marks the active menu item with aria-current while switching', async () => {
    renderPage()

    const vocabularyButton = screen.getByRole('button', { name: '词汇' })
    const phraseButton = screen.getByRole('button', { name: '短语' })
    fireEvent.click(phraseButton)
    await screen.findByRole('heading', { name: '短语' })
    expect(phraseButton).toHaveAttribute('aria-current', 'true')
    expect(vocabularyButton).not.toHaveAttribute('aria-current')

    fireEvent.click(vocabularyButton)
    await screen.findByRole('heading', { name: '词汇' })
    expect(vocabularyButton).toHaveAttribute('aria-current', 'true')
    expect(phraseButton).not.toHaveAttribute('aria-current')
  })

  it('exits through the back button and Escape', () => {
    const onExit = renderPage(vi.fn())

    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(onExit).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(screen.getByRole('main', { name: '已记录词汇' }), { key: 'Escape' })
    expect(onExit).toHaveBeenCalledTimes(2)

    // 其他按键不触发退出
    fireEvent.keyDown(screen.getByRole('main', { name: '已记录词汇' }), { key: 'Enter' })
    expect(onExit).toHaveBeenCalledTimes(2)
  })

  it('moves focus to the back button on entry', () => {
    renderPage()

    expect(screen.getByRole('button', { name: '返回' })).toHaveFocus()
  })

  it('repeats menu clicks without exiting or re-rendering content', () => {
    const onExit = renderPage(vi.fn())

    fireEvent.click(screen.getByRole('button', { name: '词汇' }))
    fireEvent.click(screen.getByRole('button', { name: '词汇' }))

    expect(screen.getByRole('main', { name: '已记录词汇' })).toBeInTheDocument()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('closes the delete dialog with Escape without exiting the page', async () => {
    vi.stubGlobal('api', {
      vocabulary: {
        ...emptyVocabularyApi,
        async list() {
          return { status: 'ok', entries: [entry] }
        }
      },
      phrase: emptyPhraseApi,
      synonym: emptySynonymApi
    })
    const onExit = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <RecordedPage onExit={onExit} />
      </I18nextProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: '删除 apple' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })

    // Escape 只关闭对话框，不冒泡触发已记录页退出。
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('apple')).toBeInTheDocument()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('renders accessible names in English', async () => {
    await i18n.changeLanguage('en')
    renderPage()

    expect(screen.getByRole('main', { name: 'Recorded vocabulary' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    const menu = within(screen.getByRole('navigation', { name: 'Recorded vocabulary menu' }))
    expect(menu.getByRole('button', { name: 'Vocabulary' })).toHaveAttribute('aria-current', 'true')
    expect(menu.getByRole('button', { name: 'Phrases' })).not.toHaveAttribute('aria-current')
    expect(menu.getByRole('button', { name: 'Synonyms' })).not.toHaveAttribute('aria-current')
  })
})
