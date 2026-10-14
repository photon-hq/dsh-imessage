import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { chunkText } from './chunks.js'
import { parseCommand, type ParsedCommand } from './commands.js'
import { markdownToPlainText } from './plaintext.js'
import { PLUGIN_ID } from './constants.js'
import { PluginError, publicError } from './errors.js'
import { InteractionBroker } from './interactions.js'
import { presetForResume, selectionForResume } from './session-selection.js'
import type { SpectrumInboundMessage } from './spectrum-runtime.js'
import { TurnCorrelation } from './turn-correlation.js'

interface AgentBinding {
  agent: Agent
  dispose(): void
}

interface SessionListItem {
  id: string
  createdAt: number
  live: boolean
  active: boolean
}

/** Durable active-session access supplied by the plugin storage domain. */
export interface ActiveSessionStore {
  /** Read the currently selected root session. */
  get(): string | undefined
  /** Persist a new selected root session or clear the selection. */
  set(sessionId: string | undefined): Promise<void>
}

/** DSH router policy. */
export interface SessionRouterOptions {
  /** Exact workspace all visible sessions must match. */
  cwd: string
  /** Session page size. */
  sessionsPerPage: number
  /** Maximum outbound grapheme count. */
  maxOutboundChars: number
  /** Interaction timeout. */
  interactionTimeoutMs: number
}

/** Routes accepted iMessage text into exact DSH turns and root sessions. */
export class SessionRouter {
  private readonly turns = new TurnCorrelation()
  private readonly bindings = new Map<Agent, AgentBinding>()
  private ownedHandle: AgentHandle | undefined
  private promptTail = Promise.resolve()
  private pendingPromptCount = 0
  private promptGeneration = 0
  private closed = false
  private runtimeHealthy = false
  readonly interactions: InteractionBroker

  /** Construct and subscribe one router. */
  constructor(
    private readonly ctx: Context,
    private readonly active: ActiveSessionStore,
    private readonly options: SessionRouterOptions,
  ) {
    this.interactions = new InteractionBroker({
      ownsCurrentTurn: agent => this.turns.owns(agent),
      channelFor: agent => this.turns.channelFor(agent),
      deliveryHealthy: () => this.runtimeHealthy,
    }, options.interactionTimeoutMs)

    ctx.on('agent/inbox/claimed', payload => this.onClaimed(payload.agent, payload.message.id, payload.turn))
    ctx.on('agent/inbox/discarded', payload => this.onDiscarded(payload.agent, payload.message.id))
    ctx.on('session/event', (session, event) => this.onSessionEvent(session.id, event))
    ctx.on('agent/disposed', ({ agent }) => this.onAgentDisposed(agent))
  }

  /** Update whether the listener is healthy enough to own interactions. */
  setRuntimeHealthy(healthy: boolean): void {
    this.runtimeHealthy = healthy
  }

  /** Accept one filtered, deduplicated text message without blocking later commands. */
  async receive(message: SpectrumInboundMessage): Promise<void> {
    if (this.closed) return
    const text = message.text.trim()
    if (text.length === 0) return

    if (!text.startsWith('/')) {
      const answered = this.interactions.answerBare(text)
      if (answered !== undefined) {
        await this.send(message, answered)
        return
      }
    }

    const escapedPrompt = text.startsWith('//') ? text.slice(1) : undefined
    const command = escapedPrompt === undefined ? parseCommand(text) : undefined
    if (command !== undefined) {
      await this.runCommand(message, command)
      return
    }

    const prompt = escapedPrompt ?? text
    const generation = this.promptGeneration
    this.pendingPromptCount += 1
    const run = this.promptTail
      .then(() => generation === this.promptGeneration ? this.processPrompt(message, prompt) : undefined)
      .finally(() => { this.pendingPromptCount -= 1 })
    this.promptTail = run.catch(() => {})
    void run.catch(async error => {
      await this.send(message, publicError(error).message).catch(() => {})
    })
  }

  /** Stop plugin-owned handles and remove scoped interception from adopted agents. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.promptGeneration += 1
    this.runtimeHealthy = false
    this.interactions.close()
    for (const binding of this.bindings.values()) {
      const queued = this.turns.cancelUnclaimed(
        binding.agent,
        new Error('The iMessage router stopped before this prompt ran.'),
      )
      for (const messageId of queued) binding.agent.inbox.remove(MessageId(messageId))
    }
    this.turns.close()
    for (const binding of this.bindings.values()) binding.dispose()
    this.bindings.clear()
    const handle = this.ownedHandle
    this.ownedHandle = undefined
    if (handle !== undefined) await handle.dispose()
    await this.promptTail.catch(() => {})
  }

  /** Clear local session selection and routing ownership without closing the router. */
  async reset(): Promise<void> {
    this.promptGeneration += 1
    const id = this.active.get()
    if (id !== undefined) {
      const agent = this.ctx.agents.get(SessionId(id))
      if (agent !== undefined) {
        const ownsTurn = this.turns.owns(agent)
        const queued = this.turns.cancelUnclaimed(
          agent,
          new PluginError('runtime-failed', 'Local iMessage routing was disconnected before this prompt ran.'),
        )
        for (const messageId of queued) agent.inbox.remove(MessageId(messageId))
        this.interactions.cancelAgent(agent)
        // A live Agent adopted from the browser is not lifecycle-owned here.
        // Stop it only when its current claimed turn is this plugin's turn;
        // unrelated browser work remains untouched.
        if (ownsTurn && agent.status === 'running') {
          agent.cancel({ kind: 'user' }, { keepInbox: true })
          await agent.whenIdle()
        }
      }
    }
    await this.releaseCurrent()
    await this.active.set(undefined)
    await this.promptTail.catch(() => {})
  }

  private async processPrompt(message: SpectrumInboundMessage, prompt: string): Promise<void> {
    const agent = await this.ensureActiveAgent()
    const response = await message.responding(() => this.runTurn(agent, message, prompt))
    if (response !== undefined && response.trim().length > 0) await this.send(message, response)
  }

  private async runTurn(
    agent: Agent,
    channel: SpectrumInboundMessage,
    prompt: string,
  ): Promise<string | undefined> {
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'imessage', plugin: PLUGIN_ID },
    })
    const result = this.turns.begin(agent, userMessage.id, channel)
    try {
      agent.followup(userMessage)
    } catch (error) {
      this.turns.failUnclaimed(
        agent,
        userMessage.id,
        error instanceof Error ? error : new Error('The DSH prompt could not be submitted.'),
      )
      throw error
    }
    return result
  }

  private onClaimed(agent: Agent, messageId: string, turn: number): void {
    this.turns.claim(agent, messageId, turn)
  }

  private onDiscarded(agent: Agent, messageId: string): void {
    this.turns.discard(agent, messageId)
  }

  private onSessionEvent(sessionId: string, event: SessionEvent): void {
    if (event.type === 'assistant/message') {
      const text = assistantText(event.data.message.content)
      this.turns.assistant(sessionId, event.data.turn, text)
      return
    }
    if (event.type !== 'turn/end') return
    this.turns.end(sessionId, event.data.turn)
  }

  private onAgentDisposed(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (binding !== undefined) {
      binding.dispose()
      this.bindings.delete(agent)
    }
    if (this.ownedHandle?.agent === agent) this.ownedHandle = undefined
    this.interactions.cancelAgent(agent)
    this.turns.disposeAgent(agent)
  }

  private async runCommand(message: SpectrumInboundMessage, command: ParsedCommand): Promise<void> {
    try {
      let response: string
      switch (command.name) {
        case 'help':
          response = HELP_TEXT
          break
        case 'status':
          response = await this.statusText()
          break
        case 'new':
          assertNoArguments(command)
          response = await this.newSession()
          break
        case 'sessions':
          response = await this.sessionsText(command.arguments)
          break
        case 'switch':
          response = await this.switchSession(command.arguments)
          break
        case 'stop':
        case 'cancel':
          assertNoArguments(command)
          response = await this.stopActive()
          break
        case 'approve':
          response = this.interactions.approve(requireSingleArgument(command, 'Usage: /approve <request-id>'))
          break
        case 'deny':
          response = this.interactions.deny(requireSingleArgument(command, 'Usage: /deny <request-id>'))
          break
        case 'answer': {
          const match = /^(\S+)\s+([\s\S]+)$/u.exec(command.arguments)
          if (!match?.[1] || !match[2]) throw new PluginError('invalid-command', 'Usage: /answer <request-id> <option-or-text>')
          response = this.interactions.answer(match[1], match[2])
          break
        }
        default:
          throw new PluginError('invalid-command', `Unknown command /${command.name}. Send /help for commands.`)
      }
      await this.send(message, response)
    } catch (error) {
      await this.send(message, publicError(error).message)
    }
  }

  private async statusText(): Promise<string> {
    const id = this.active.get()
    if (id === undefined) return 'iMessage routing is ready. No DSH session is selected; your next prompt will create one.'
    const agent = this.ctx.agents.get(SessionId(id))
    const phase = agent?.status ?? 'stored'
    const interaction = agent !== undefined && this.interactions.hasPending(agent) ? ' • waiting for your response' : ''
    return `Active session: ${id}\nState: ${phase}${interaction}`
  }

  private async newSession(): Promise<string> {
    await this.assertSwitchAllowed()
    await this.releaseCurrent()
    const handle = await this.createAgent()
    this.ownedHandle = handle
    await this.active.set(handle.agent.id)
    return `Created and selected session ${handle.agent.id}.`
  }

  private async sessionsText(rawPage: string): Promise<string> {
    const page = rawPage.trim().length === 0 ? 1 : Number(rawPage.trim())
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new PluginError('invalid-command', 'Usage: /sessions [positive-page-number]')
    }
    const sessions = await this.listSessions()
    if (sessions.length === 0) return 'No root DSH sessions exist in this workspace.'
    const pages = Math.max(1, Math.ceil(sessions.length / this.options.sessionsPerPage))
    if (page > pages) throw new PluginError('invalid-command', `Page ${page} does not exist; there are ${pages} pages.`)
    const start = (page - 1) * this.options.sessionsPerPage
    const rows = sessions.slice(start, start + this.options.sessionsPerPage).map((session, offset) => {
      const marker = session.active ? '*' : session.live ? '•' : ' '
      return `${start + offset + 1}. ${marker} ${session.id}`
    })
    return [`Sessions ${page}/${pages} (* active, • live)`, ...rows, 'Use /switch <index|session-id>.'].join('\n')
  }

  private async switchSession(target: string): Promise<string> {
    const value = target.trim()
    if (value.length === 0) throw new PluginError('invalid-command', 'Usage: /switch <index|session-id>')
    await this.assertSwitchAllowed()
    const sessions = await this.listSessions()
    let selected: SessionListItem | undefined
    if (/^\d+$/u.test(value)) selected = sessions[Number(value) - 1]
    else {
      const exact = sessions.find(item => item.id === value)
      const prefixes = sessions.filter(item => item.id.startsWith(value))
      if (exact !== undefined) selected = exact
      else if (prefixes.length === 1) selected = prefixes[0]
      else if (prefixes.length > 1) {
        throw new PluginError('invalid-command', 'That session id prefix is ambiguous; send more characters.')
      }
    }
    if (selected === undefined) throw new PluginError('invalid-command', 'No same-workspace root session matches that selection.')
    if (selected.id === this.active.get()) return `Session ${selected.id} is already active.`
    await this.releaseCurrent()
    await this.active.set(selected.id)
    const live = this.ctx.agents.get(SessionId(selected.id))
    if (live !== undefined) this.bindAgent(live)
    return `Selected session ${selected.id}.`
  }

  private async stopActive(): Promise<string> {
    this.promptGeneration += 1
    const id = this.active.get()
    if (id === undefined) return 'No active DSH session is running.'
    const agent = this.ctx.agents.get(SessionId(id))
    if (agent === undefined || agent.status === 'idle') return `Session ${id} is already idle.`
    this.interactions.cancelAgent(agent)
    agent.cancel({ kind: 'user' })
    return `Stopping session ${id}.`
  }

  private async assertSwitchAllowed(): Promise<void> {
    if (this.pendingPromptCount > 0) {
      throw new PluginError('busy', 'An iMessage prompt is queued or running. Send /stop before switching.')
    }
    const id = this.active.get()
    if (id === undefined) return
    const agent = this.ctx.agents.get(SessionId(id))
    if (agent !== undefined && (agent.status === 'running' || this.interactions.hasPending(agent))) {
      throw new PluginError('busy', 'The active session is busy or awaiting your response. Send /stop before switching.')
    }
  }

  private async ensureActiveAgent(): Promise<Agent> {
    const selected = this.active.get()
    if (selected === undefined) {
      const handle = await this.createAgent()
      this.ownedHandle = handle
      await this.active.set(handle.agent.id)
      return handle.agent
    }
    const id = SessionId(selected)
    const live = this.ctx.agents.get(id)
    if (live !== undefined) {
      if (!this.isVisibleLiveRoot(live)) {
        throw new PluginError('runtime-failed', 'The selected session is not a root session in this workspace.')
      }
      this.bindAgent(live)
      return live
    }

    // The observation is a Disposable read lease; hold it only while resuming.
    using observation = await this.ctx.sessionQuery.observeSession(id)
    if (!this.isVisibleHeader(observation.header)) {
      throw new PluginError('runtime-failed', 'The selected session is not a root session in this workspace.')
    }
    try {
      const handle = await this.resumeAgent(id, observation)
      this.ownedHandle = handle
      return handle.agent
    } catch (error) {
      // A browser request may have resumed the same cold session after our
      // initial registry read. Adopt that exact live root instead of treating
      // the benign ownership race as a failed iMessage prompt.
      const raced = this.ctx.agents.get(id)
      if (raced === undefined || !this.isVisibleLiveRoot(raced)) throw error
      this.bindAgent(raced)
      return raced
    }
  }

  private async createAgent(): Promise<AgentHandle> {
    const id = SessionId(`imessage-${randomUUID()}`)
    const presetId = this.ctx.agentPresets.defaultId
    const selection = this.ctx.agentDefaultModel.currentSelection()
    let disposeBinding: (() => void) | undefined
    const handle = await this.ctx.agents.create({
      sessionId: id,
      meta: { cwd: this.options.cwd, agentPreset: presetId },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async agentCtx => {
        await this.ctx.agentPresets.mount(agentCtx, presetId)
        installSelection(agentCtx, selection)
        disposeBinding = this.interactions.install(agentCtx, this.ctx)
      },
    })
    this.bindings.set(handle.agent, {
      agent: handle.agent,
      dispose: once(() => disposeBinding?.()),
    })
    return handle
  }

  private async resumeAgent(
    id: ReturnType<typeof SessionId>,
    observation: Pick<SessionObservation, 'header' | 'events' | 'projections'>,
  ): Promise<AgentHandle> {
    const presetId = presetForResume(observation)
    const selection = selectionForResume(observation.events, this.ctx.agentDefaultModel.currentSelection())
    let disposeBinding: (() => void) | undefined
    const handle = await this.ctx.agents.resume({
      resumeSessionId: id,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async agentCtx => {
        await this.ctx.agentPresets.mount(agentCtx, presetId)
        installSelection(agentCtx, selection)
        disposeBinding = this.interactions.install(agentCtx, this.ctx)
      },
    })
    this.bindings.set(handle.agent, {
      agent: handle.agent,
      dispose: once(() => disposeBinding?.()),
    })
    return handle
  }

  private bindAgent(agent: Agent): void {
    if (this.bindings.has(agent)) return
    const dispose = this.interactions.install(agent.ctx, this.ctx)
    this.bindings.set(agent, { agent, dispose: once(dispose) })
  }

  private async releaseCurrent(): Promise<void> {
    const selected = this.active.get()
    if (selected !== undefined) {
      const agent = this.ctx.agents.get(SessionId(selected))
      if (agent !== undefined) {
        const binding = this.bindings.get(agent)
        binding?.dispose()
        this.bindings.delete(agent)
      }
    }
    const handle = this.ownedHandle
    this.ownedHandle = undefined
    if (handle !== undefined) await handle.dispose()
  }

  private async listSessions(): Promise<SessionListItem[]> {
    const rows = new Map<string, SessionListItem>()
    const active = this.active.get()
    for (const agent of this.ctx.agents.roots()) {
      if (!this.isVisibleLiveRoot(agent)) continue
      rows.set(agent.id, {
        id: agent.id,
        createdAt: agent.session.header.createdAt,
        live: true,
        active: agent.id === active,
      })
    }
    for (const { header } of await this.ctx.sessionPersistence.list()) {
      if (!this.isVisibleHeader(header)) continue
      const existing = rows.get(header.id)
      rows.set(header.id, existing ?? {
        id: header.id,
        createdAt: header.createdAt,
        live: false,
        active: header.id === active,
      })
    }
    return [...rows.values()].sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
  }

  private isVisibleLiveRoot(agent: Agent): boolean {
    return agent.session.header.cwd === this.options.cwd
      && agent.session.header.origin !== 'subagent'
      && (agent.session.header.delegationDepth ?? 0) === 0
      && this.ctx.agents.roots().includes(agent)
  }

  private isVisibleHeader(header: SessionHeader): boolean {
    return header.cwd === this.options.cwd
      && header.origin !== 'subagent'
      && (header.delegationDepth ?? 0) === 0
  }

  private async send(channel: SpectrumInboundMessage, text: string): Promise<void> {
    for (const chunk of chunkText(text, this.options.maxOutboundChars)) await channel.send(chunk)
  }
}

function installSelection(agentCtx: Context, selection: ModelSelection): void {
  const ref: ModelSelectionRef = { current: selection, assembled: undefined }
  installModelSelection(agentCtx, ref)
}

function assistantText(content: readonly unknown[]): string {
  const text = content.flatMap(block => {
    if (!block || typeof block !== 'object') return []
    const record = block as Record<string, unknown>
    return record['type'] === 'text' && typeof record['text'] === 'string' ? [record['text']] : []
  }).join('')
  // iMessage is text-only: deliver the answer as plain text instead of raw
  // markdown markers. Commands and errors are authored plain and never pass here.
  return markdownToPlainText(text)
}

function assertNoArguments(command: ParsedCommand): void {
  if (command.arguments.length > 0) {
    throw new PluginError('invalid-command', `/${command.name} does not accept arguments.`)
  }
}

function requireSingleArgument(command: ParsedCommand, usage: string): string {
  const value = command.arguments.trim()
  if (value.length === 0 || /\s/u.test(value)) throw new PluginError('invalid-command', usage)
  return value
}

function once(callback: () => void): () => void {
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    callback()
  }
}

const HELP_TEXT = [
  'DSH iMessage commands',
  '/new — create and select a session',
  '/sessions [page] — list same-workspace root sessions',
  '/switch <index|session-id> — select a session',
  '/status — show listener session state',
  '/stop or /cancel — stop the active turn',
  '/approve <request-id> or /deny <request-id>',
  '/answer <request-id> <option-or-text>',
  '//text — send an ordinary prompt beginning with /',
].join('\n')
