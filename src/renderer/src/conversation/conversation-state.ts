import type {
  ConversationEvent,
  ConversationMessage,
  ConversationRequestError,
  ConversationSkillId,
  ConversationSummary,
  GenerationEventError,
  GenerationStarted
} from '../../../shared/conversation'

// Renderer 侧投影的消息：以 canonical messageId 为唯一身份与 React key，
// requestId 只存在于 activeRequests 索引，不允许进入消息实体。
// reasoning 是流式期间的临时思考预览缓冲：'' 表示已启用、等待首个思考或
// 正文增量（显示占位），undefined 表示不展示（技能请求，或正文已开始且
// 一直没有思考内容）；终态后一律移除。
export interface DisplayMessage {
  messageId: string
  role: 'user' | 'assistant'
  content: string
  streaming: boolean
  retryable: boolean
  reasoning?: string
}

interface ActiveGeneration {
  requestId: string
  sessionId: string
  userMessageId: string
  assistantMessageId: string
}

export type ConversationPhase = 'loading' | 'ready' | 'failed'

// 触发一次交互的位置；IPC 拒绝时用它选择本地语义的失败提示。
export type StatusOperation = 'load' | 'list' | 'create' | 'send' | 'runSkill' | 'cancel' | 'retry'

// 状态只保留语义与安全错误信息，不保存翻译后的文案；
// 组件在每次 render 时按当前界面语言翻译，切换语言即可更新既有提示。
// 技能相关状态携带 skillId（由 user 消息内容派生），用于按技能选择文案；
// 无法识别时省略，展示层回退到通用文案。
export type ConversationStatus =
  | { kind: 'restoring' }
  | { kind: 'switching' }
  | { kind: 'creating' }
  | { kind: 'ready' }
  | { kind: 'generating' }
  | { kind: 'generatingTitle' }
  | {
      kind: 'skillPhase'
      phase: 'analyzing' | 'committing' | 'summarizing'
      skillId?: ConversationSkillId
    }
  | { kind: 'completed' }
  | { kind: 'skillDescriptionFailed'; cancelled: boolean; skillId?: ConversationSkillId }
  | { kind: 'cancelled' }
  | { kind: 'protocolError' }
  | { kind: 'generationError'; error: GenerationEventError }
  | { kind: 'requestError'; operation: StatusOperation; error: ConversationRequestError }
  | { kind: 'ipcError'; operation: StatusOperation }

export type FailureStatus = Extract<ConversationStatus, { kind: 'requestError' | 'ipcError' }>

export interface ConversationState {
  phase: ConversationPhase
  sessionId: string | undefined
  conversations: ConversationSummary[]
  messages: DisplayMessage[]
  activeRequests: Record<string, ActiveGeneration>
  // 已终态的请求：迟到的事件（chunk、重复 started）不得再触碰消息集合。
  finishedRequests: Record<string, boolean>
  commandPending: boolean
  status: ConversationStatus
}

export type ConversationAction =
  | {
      type: 'loadPhaseStarted'
      status: Extract<ConversationStatus, { kind: 'restoring' | 'switching' | 'creating' }>
    }
  | { type: 'recoverFailed'; status: FailureStatus }
  | { type: 'transitionFailed'; status: FailureStatus }
  | { type: 'conversationsListed'; conversations: ConversationSummary[] }
  | { type: 'conversationLoaded'; sessionId: string; messages: ConversationMessage[] }
  | { type: 'generationStarted'; generation: GenerationStarted }
  | { type: 'generationEvent'; event: ConversationEvent }
  | { type: 'commandStarted' }
  | { type: 'commandSettled' }
  | { type: 'commandFailed'; status: FailureStatus }
  | { type: 'statusChanged'; status: ConversationStatus }

export const initialConversationState: ConversationState = {
  phase: 'loading',
  sessionId: undefined,
  conversations: [],
  messages: [],
  activeRequests: {},
  finishedRequests: {},
  commandPending: false,
  status: { kind: 'restoring' }
}

export function reduceConversation(
  state: ConversationState,
  action: ConversationAction
): ConversationState {
  switch (action.type) {
    case 'loadPhaseStarted':
      return { ...state, phase: 'loading', status: action.status }
    case 'recoverFailed':
      return { ...state, phase: 'failed', status: action.status }
    case 'transitionFailed':
      return { ...state, phase: 'ready', status: action.status }
    case 'conversationsListed':
      return { ...state, conversations: action.conversations }
    case 'conversationLoaded':
      return {
        ...state,
        phase: 'ready',
        sessionId: action.sessionId,
        messages: toDisplayMessages(action.messages),
        activeRequests: {},
        finishedRequests: {},
        status: { kind: 'ready' }
      }
    case 'generationStarted':
      return applyGenerationStarted(state, action.generation)
    case 'generationEvent':
      return applyEvent(state, action.event)
    case 'commandStarted':
      return {
        ...state,
        commandPending: true,
        status: state.messages.length === 0 ? { kind: 'generatingTitle' } : state.status
      }
    case 'commandSettled':
      return { ...state, commandPending: false }
    case 'commandFailed':
      return { ...state, commandPending: false, status: action.status }
    case 'statusChanged':
      return { ...state, status: action.status }
  }
}

export function isGenerating(state: ConversationState): boolean {
  return Object.keys(state.activeRequests).length > 0
}

// 思考预览的有界尾部缓冲上限（Unicode 码点）：超限后只保留最新内容，
// 与组件层的三行视觉限制分别实现。
export const REASONING_PREVIEW_MAX_CODE_POINTS = 4_000

// 追加思考增量并在超限时裁剪到尾部：按 Unicode 码点数计不超过上限；
// 裁剪先按码元粗剪（码点数 ≤ 2 倍上限的窗口）避免展开超长增量，
// 并避让被截断的代理对。
function appendReasoningDelta(current: string, delta: string): string {
  const next = current + delta
  // 快速路径：码元数不超过上限时，码点数必然也不超过上限。
  if (next.length <= REASONING_PREVIEW_MAX_CODE_POINTS) return next
  let window =
    next.length > REASONING_PREVIEW_MAX_CODE_POINTS * 2
      ? next.slice(next.length - REASONING_PREVIEW_MAX_CODE_POINTS * 2)
      : next
  const leadingUnit = window.charCodeAt(0)
  if (leadingUnit >= 0xdc00 && leadingUnit <= 0xdfff) window = window.slice(1)
  const codePoints = [...window]
  if (codePoints.length <= REASONING_PREVIEW_MAX_CODE_POINTS) return codePoints.join('')
  return codePoints.slice(-REASONING_PREVIEW_MAX_CODE_POINTS).join('')
}

// 从消息内容派生技能身份；命令前缀是 canonical 数据，不依赖内存标记。
// /concept 是普通对话流（概念讲解提示词），不属于技能。/explore-phrase 是
// 无参数命令：会话中保存的形态就是命令本身。
function skillCommandOf(content: string): ConversationSkillId | undefined {
  if (content.startsWith('/synonym ')) return 'synonym'
  if (content.startsWith('/phrase ')) return 'phrase'
  if (content.startsWith('/vocabulary ')) return 'vocabulary'
  if (content === '/explore-phrase' || content.startsWith('/explore-phrase ')) {
    return 'explore-phrase'
  }
  return undefined
}

// 从活动请求对应的 user 消息内容派生技能身份；命令前缀是 canonical 数据，
// 不依赖 Renderer 侧的内存标记。
function skillOfRequest(
  state: ConversationState,
  active: ActiveGeneration
): ConversationSkillId | undefined {
  const content = state.messages.find(
    (message) => message.messageId === active.userMessageId
  )?.content
  return content ? skillCommandOf(content) : undefined
}

// 加载历史时，最后一条没有 assistant 回复的 user 消息投影为可重试，
// 应用异常退出后不会出现永久 generating。
function toDisplayMessages(messages: ConversationMessage[]): DisplayMessage[] {
  const display = messages.map((message) => ({
    messageId: message.messageId,
    role: message.role,
    content: message.content,
    streaming: false,
    retryable: message.role === 'user' && message.retryable === true
  }))
  const last = display.at(-1)
  if (last?.role === 'user') {
    last.retryable = true
  }
  return display
}

// send 结果与 started 事件共享同一 canonical 载荷，按 ID 幂等归并，不依赖到达顺序。
function applyGenerationStarted(
  state: ConversationState,
  generation: GenerationStarted
): ConversationState {
  if (generation.sessionId !== state.sessionId) return state
  if (state.finishedRequests[generation.requestId]) return state
  if (state.activeRequests[generation.requestId]) return state

  let messages = upsertMessage(state.messages, {
    messageId: generation.userMessage.messageId,
    role: 'user',
    content: generation.userMessage.content,
    streaming: false,
    retryable: false
  })
  messages = upsertMessage(messages, {
    messageId: generation.assistantMessageId,
    role: 'assistant',
    content: '',
    streaming: true,
    retryable: false,
    // 普通对话流（含 /concept）启用思考预览占位；技能请求沿用既有
    // 阶段状态展示，不显示思考占位。
    ...(skillCommandOf(generation.userMessage.content) ? {} : { reasoning: '' })
  })

  return {
    ...state,
    messages,
    activeRequests: {
      ...state.activeRequests,
      [generation.requestId]: {
        requestId: generation.requestId,
        sessionId: generation.sessionId,
        userMessageId: generation.userMessage.messageId,
        assistantMessageId: generation.assistantMessageId
      }
    },
    status: { kind: 'generating' }
  }
}

function applyEvent(state: ConversationState, event: ConversationEvent): ConversationState {
  // 只接受与当前会话一致的事件，避免切换后旧事件写入新视图。
  if (event.sessionId !== state.sessionId) return state
  if (state.finishedRequests[event.requestId]) return state

  switch (event.type) {
    case 'titleUpdated':
      return state
    case 'started':
      return applyGenerationStarted(state, event)

    case 'skillPhase': {
      const active = state.activeRequests[event.requestId]
      if (!active) return state
      const skillId = skillOfRequest(state, active)
      return {
        ...state,
        status: { kind: 'skillPhase', phase: event.phase, ...(skillId ? { skillId } : {}) }
      }
    }

    case 'reasoningChunk': {
      const active = state.activeRequests[event.requestId]
      if (!active) return state
      if (event.messageId !== active.assistantMessageId) {
        return { ...state, status: { kind: 'protocolError' } }
      }
      // 空增量不改变占位状态；有效思考可在正文开始后重新显示预览。
      if (event.delta.length === 0) return state

      const messages = state.messages.map((message) =>
        message.messageId === event.messageId && message.streaming
          ? { ...message, reasoning: appendReasoningDelta(message.reasoning ?? '', event.delta) }
          : message
      )
      return { ...state, messages }
    }

    case 'chunk': {
      const active = state.activeRequests[event.requestId]
      if (!active) return state
      if (event.messageId !== active.assistantMessageId) {
        return { ...state, status: { kind: 'protocolError' } }
      }

      const messages = state.messages.map((message) => {
        if (message.messageId !== event.messageId || !message.streaming) return message
        const next: DisplayMessage = { ...message, content: message.content + event.delta }
        // 第一段正文到达时撤下无内容的思考占位；已有思考内容的预览
        // 保留至请求完成。
        if (message.reasoning === '') delete next.reasoning
        return next
      })
      return { ...state, messages }
    }

    case 'completed': {
      const active = state.activeRequests[event.requestId]
      if (!active) return state

      if (event.message.messageId !== active.assistantMessageId) {
        return retireInvalidTerminal(state, event.requestId, active)
      }

      const skillId = skillOfRequest(state, active)
      const retired = retireRequest(state, event.requestId)

      // 用持久化消息原位对账 draft，canonical key 不变，不产生重复消息。
      const completed: DisplayMessage = {
        messageId: event.message.messageId,
        role: 'assistant',
        content: event.message.content,
        streaming: false,
        retryable: false
      }
      let messages = upsertMessage(retired.messages, completed)
      if (event.retryableUserMessageId) {
        messages = messages.map((message) =>
          message.messageId === event.retryableUserMessageId
            ? { ...message, retryable: true }
            : message
        )
      }
      return {
        ...retired,
        messages,
        status:
          event.skillCompletion === 'description_failed' ||
          event.skillCompletion === 'description_cancelled'
            ? {
                kind: 'skillDescriptionFailed',
                cancelled: event.skillCompletion === 'description_cancelled',
                ...(skillId ? { skillId } : {})
              }
            : { kind: 'completed' }
      }
    }

    case 'cancelled': {
      const active = state.activeRequests[event.requestId]
      if (!active) return state

      if (event.messageId !== active.assistantMessageId) {
        return retireInvalidTerminal(state, event.requestId, active)
      }

      const retired = retireRequest(state, event.requestId)

      return {
        ...retired,
        messages: dropAssistantDraft(retired.messages, active),
        status: { kind: 'cancelled' }
      }
    }

    case 'failed': {
      const active = state.activeRequests[event.requestId]
      if (!active) return state

      if (event.messageId && event.messageId !== active.assistantMessageId) {
        return retireInvalidTerminal(state, event.requestId, active)
      }

      const retired = retireRequest(state, event.requestId)

      return {
        ...retired,
        messages: dropAssistantDraft(retired.messages, active),
        status: { kind: 'generationError', error: event.error }
      }
    }
  }
}

function retireInvalidTerminal(
  state: ConversationState,
  requestId: string,
  active: ActiveGeneration
): ConversationState {
  const retired = retireRequest(state, requestId)
  return {
    ...retired,
    messages: dropAssistantDraft(retired.messages, active),
    status: { kind: 'protocolError' }
  }
}

function retireRequest(state: ConversationState, requestId: string): ConversationState {
  const activeRequests = { ...state.activeRequests }
  delete activeRequests[requestId]
  return {
    ...state,
    activeRequests,
    finishedRequests: { ...state.finishedRequests, [requestId]: true }
  }
}

// failed/cancelled 删除未持久化的 assistant draft，保留 user 并标记可重试。
function dropAssistantDraft(
  messages: DisplayMessage[],
  active: ActiveGeneration
): DisplayMessage[] {
  return messages
    .filter((message) => message.messageId !== active.assistantMessageId)
    .map((message) =>
      message.messageId === active.userMessageId ? { ...message, retryable: true } : message
    )
}

function upsertMessage(messages: DisplayMessage[], next: DisplayMessage): DisplayMessage[] {
  const index = messages.findIndex((message) => message.messageId === next.messageId)
  if (index === -1) return [...messages, next]
  const copy = [...messages]
  copy[index] = next
  return copy
}
