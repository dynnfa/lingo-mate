import { ExplorePhraseError } from './explore-phrase-error'
import { ExploreSerialLock } from '../explore-serial-lock'

// /explore-phrase 的技能内串行锁实例：跨会话共享，错误类型为短语领域错误。
export class ExplorePhraseSerialLock extends ExploreSerialLock {
  constructor() {
    super(() => new ExplorePhraseError('CANCELLED'))
  }
}
