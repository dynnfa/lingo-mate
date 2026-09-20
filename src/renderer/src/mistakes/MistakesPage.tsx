import { useTranslation } from 'react-i18next'
import { PageShell } from '../components/PageShell'
import { VocabularyMistakesDetail } from './vocabulary/VocabularyMistakesDetail'

interface MistakesPageProps {
  onExit: () => void
}

// 错题集页骨架：首版仅“单词”一类错题；骨架结构（菜单、返回、Escape、
// 挂载聚焦）由 PageShell 提供，切换菜单即卸载另一详情，重新进入时
// 读取最新数据。退出后由调用方把焦点还给「错题集」入口。
export function MistakesPage({ onExit }: MistakesPageProps): React.JSX.Element {
  const { t } = useTranslation('common')

  return (
    <PageShell
      exitLabel={t('mistakes.back')}
      menuLabel={t('mistakes.menuLabel')}
      onExit={onExit}
      sections={[
        {
          id: 'vocabulary',
          label: t('mistakes.sections.vocabulary'),
          content: <VocabularyMistakesDetail />
        }
      ]}
      title={t('mistakes.title')}
    />
  )
}
