import type { LanguageModel, StreamReplyInput } from './language-model'
import { ModelConfigService, ModelNotConfiguredError } from './model-config'
import { RemoteLanguageModel } from './remote-language-model'

// 模型入口：每次生成开始时解析一次配置快照并创建客户端；在途流式请求持有
// 自己的快照，保存或清除配置不打断已开始的生成。未配置时抛出明确错误，
// 不在远程请求失败后回退到模拟模型。
export class ConfiguredLanguageModel implements LanguageModel {
  constructor(private readonly configService: ModelConfigService) {}

  async *streamReply(input: StreamReplyInput): AsyncIterable<string> {
    const config = this.configService.resolveSnapshot()
    if (!config.configured) {
      throw new ModelNotConfiguredError()
    }
    const model = new RemoteLanguageModel(config)
    yield* model.streamReply(input)
  }
}
