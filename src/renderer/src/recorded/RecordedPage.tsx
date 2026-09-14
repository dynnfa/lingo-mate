import { useTranslation } from 'react-i18next'
import { PageShell } from '../components/PageShell'
import { PhraseDetail } from './phrase/PhraseDetail'
import { SynonymDetail } from './synonym/SynonymDetail'
import { VocabularyDetail } from './vocabulary/VocabularyDetail'

interface RecordedPageProps {
  onExit: () => void
}

// 已记录页骨架：左侧菜单含词汇、短语与近义词三项，默认选中词汇，右侧渲染对应详情。
// 切换菜单即卸载另一详情：视图状态不跨菜单保留，重新进入时读取最新列表。
// 骨架结构（菜单、返回、Escape、挂载聚焦）由 PageShell 提供。
// 退出后由调用方把焦点还给「已记录」入口。
export function RecordedPage({ onExit }: RecordedPageProps): React.JSX.Element {
  const { t } = useTranslation('common')

  return (
    <PageShell
      exitLabel={t('recorded.back')}
      menuLabel={t('recorded.menuLabel')}
      onExit={onExit}
      sections={[
        {
          id: 'vocabulary',
          label: t('recorded.sections.vocabulary'),
          content: <VocabularyDetail />
        },
        { id: 'phrase', label: t('recorded.sections.phrase'), content: <PhraseDetail /> },
        { id: 'synonym', label: t('recorded.sections.synonym'), content: <SynonymDetail /> }
      ]}
      title={t('recorded.title')}
    />
  )
}
