import type { LanguageModel, ModelStreamEvent, StreamReplyInput } from './language-model'
import { ModelConfigService, ModelNotConfiguredError } from './model-config'
import { RemoteLanguageModel, CHAT_REQUEST_TIMEOUT_MS } from './remote-language-model'
import type { CreateLlmClient } from './llm-client'

// 模型入口：每次生成开始时解析一次配置快照并创建客户端；在途流式请求持有
// 自己的快照，保存或清除配置不打断已开始的生成。未配置时抛出明确错误，
// 不在远程请求失败后回退到模拟模型。
export class ConfiguredLanguageModel implements LanguageModel {
  constructor(
    private readonly configService: ModelConfigService,
    private readonly createClient: CreateLlmClient
  ) {}

  async *streamReply(input: StreamReplyInput): AsyncIterable<ModelStreamEvent> {
    const config = this.configService.resolveSnapshot()
    if (!config.configured) {
      throw new ModelNotConfiguredError()
    }
    const model = new RemoteLanguageModel(config, CHAT_REQUEST_TIMEOUT_MS, this.createClient)
    yield* model.streamReply(input)
  }
}
