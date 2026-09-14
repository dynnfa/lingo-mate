import { useTranslation } from 'react-i18next'
import { PageShell } from '../components/PageShell'
import { SentencePracticeDetail } from './sentence/SentencePracticeDetail'
import { VocabularyPracticeDetail } from './vocabulary/VocabularyPracticeDetail'

interface PracticePageProps {
  onExit: () => void
}

// 练习页骨架：左侧菜单有“词汇练习”（默认选中）与“造句练习”两项，
// 右侧渲染对应详情；切换菜单时旧详情卸载并中止其在途请求。
// 骨架结构（菜单、返回、Escape、挂载聚焦）由 PageShell 提供。
// 退出后由调用方把焦点还给「开始练习」入口。
export function PracticePage({ onExit }: PracticePageProps): React.JSX.Element {
  const { t } = useTranslation('common')

  return (
    <PageShell
      exitLabel={t('practice.back')}
      menuLabel={t('practice.menuLabel')}
      onExit={onExit}
      sections={[
        {
          id: 'vocabulary',
          label: t('practice.sections.vocabulary'),
          content: <VocabularyPracticeDetail />
        },
        {
          id: 'sentence',
          label: t('practice.sections.sentence'),
          content: <SentencePracticeDetail />
        }
      ]}
      title={t('practice.title')}
    />
  )
}
