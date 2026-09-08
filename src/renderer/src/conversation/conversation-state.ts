import type {
  ConversationEvent,
  ConversationMessage,
  ConversationRequestError,
  ConversationSummary,
  GenerationEventError,
  GenerationStarted
} from '../../../shared/conversation'

// Renderer 侧投影的消息：以 canonical messageId 为唯一身份与 React key，
// requestId 只存在于 activeRequests 索引，不允许进入消息实体。
export interface DisplayMessage {
  messageId: string
  role: 'user' | 'assistant'
  content: string
  streaming: boolean
  retryable: boolean
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
export type ConversationStatus =
  | { kind: 'restoring' }
  | { kind: 'switching' }
  | { kind: 'creating' }
  | { kind: 'ready' }
  | { kind: 'generating' }
  | { kind: 'generatingTitle' }
  | { kind: 'skillPhase'; phase: 'analyzing' | 'committing' | 'summarizing' }
  | { kind: 'completed' }
  | { kind: 'skillDescriptionFailed'; cancelled: boolean }
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
    retryable: false
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
      if (!state.activeRequests[event.requestId]) return state
      return { ...state, status: { kind: 'skillPhase', phase: event.phase } }
    }

    case 'chunk': {
      const active = state.activeRequests[event.requestId]
      if (!active) return state
      if (event.messageId !== active.assistantMessageId) {
        return { ...state, status: { kind: 'protocolError' } }
      }

      const messages = state.messages.map((message) =>
        message.messageId === event.messageId && message.streaming
          ? { ...message, content: message.content + event.delta }
          : message
      )
      return { ...state, messages }
    }

    case 'completed': {
      const active = state.activeRequests[event.requestId]
      if (!active) return state

      if (event.message.messageId !== active.assistantMessageId) {
        return retireInvalidTerminal(state, event.requestId, active)
      }

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
                cancelled: event.skillCompletion === 'description_cancelled'
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
