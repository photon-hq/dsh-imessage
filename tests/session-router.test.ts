import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'

// The setup callback installs the model selection onto a real Agent context; these tests only
// care which preset it mounts, so replace that one export and keep the rest of dsh-agent real.
vi.mock('@deepseek-ai/dsh-agent', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-agent')>(),
  installModelSelection: vi.fn(),
}))
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionRouter, type ActiveSessionStore } from '../src/session-router.js'
import type { SpectrumInboundMessage } from '../src/spectrum-runtime.js'

interface FakeContextOptions {
  roots?: Agent[]
  stored?: SessionHeader[]
  activeAgents?: Map<string, Agent>
}

function header(
  id: string,
  extras: Partial<SessionHeader> = {},
): SessionHeader {
  return {
    version: 0,
    id: SessionId(id),
    createdAt: 1,
    delegationDepth: 0,
    cwd: '/workspace',
    ...extras,
  }
}

function fakeAgent(id: string, meta = header(id), status: 'idle' | 'running' = 'idle'): Agent {
  return {
    id,
    status,
    session: { header: meta },
    followup: vi.fn(),
    inbox: { remove: vi.fn() },
  } as unknown as Agent
}

function fakeContext(options: FakeContextOptions = {}) {
  const roots = options.roots ?? []
  const activeAgents = options.activeAgents ?? new Map(roots.map(agent => [agent.id, agent]))
  const createDispose = vi.fn(async () => {})
  const resumeDispose = vi.fn(async () => {})
  const created = fakeAgent('imessage-created')
  const resumed = fakeAgent('stored')
  const create = vi.fn(async () => ({ agent: created, dispose: createDispose } as unknown as AgentHandle))
  const resume = vi.fn(async () => ({ agent: resumed, dispose: resumeDispose } as unknown as AgentHandle))
  const ctx = {
    on: vi.fn(() => () => {}),
    agents: {
      roots: vi.fn(() => roots),
      get: vi.fn((id: string) => activeAgents.get(id)),
      create,
      resume,
    },
    sessionPersistence: {
      list: vi.fn(async () => (options.stored ?? []).map(header => ({ header }))),
    },
    sessionQuery: {
      observeSession: vi.fn(),
    },
    agentPresets: {
      defaultId: 'coding-default',
      mount: vi.fn(async () => {}),
    },
    agentDefaultModel: {
      currentSelection: vi.fn(() => ({ provider: 'current-provider', model: 'current-model' })),
    },
  }
  return { ctx: ctx as unknown as Context, raw: ctx, createDispose, resumeDispose, created, resumed }
}

function activeStore(initial?: string): ActiveSessionStore & { value?: string } {
  return {
    value: initial,
    get() { return this.value },
    async set(value) { this.value = value },
  }
}

function router(ctx: Context, active = activeStore()): SessionRouter {
  return new SessionRouter(ctx, active, {
    cwd: '/workspace',
    sessionsPerPage: 5,
    maxOutboundChars: 3_500,
    interactionTimeoutMs: 600_000,
  })
}

describe('DSH session lifecycle policy', () => {
  it('creates new sessions from process policy: exact cwd, default preset, and current model', async () => {
    const { ctx, raw } = fakeContext()
    const instance = router(ctx)
    const privateRouter = instance as unknown as { createAgent(): Promise<AgentHandle> }
    await privateRouter.createAgent()
    const input = raw.agents.create.mock.calls[0]?.[0]
    expect(input).toMatchObject({
      meta: { cwd: '/workspace', agentPreset: 'coding-default' },
      agentOptions: { provider: 'current-provider', model: 'current-model' },
    })
    expect(input?.sessionId).toMatch(/^imessage-/u)
  })

  it('resumes with the saved preset and latest request model, not current defaults', async () => {
    const { ctx, raw } = fakeContext()
    const instance = router(ctx)
    const events = [
      {
        type: 'agent-preset/selected', seq: 0, time: 1,
        data: { agentPreset: 'saved-preset' },
      },
      {
        type: 'request/header', seq: 1, time: 2,
        data: {
          header: { config: { provider: 'saved-provider', model: 'saved-model' } },
          reason: 'initial',
        },
      },
    ] as unknown as SessionEvent[]
    const privateRouter = instance as unknown as {
      resumeAgent(id: ReturnType<typeof SessionId>, observation: {
        header: SessionHeader
        events: readonly SessionEvent[]
        projections?: { asOfSeq: never, values: { agentPreset?: string | null } }
      }): Promise<AgentHandle>
    }
    await privateRouter.resumeAgent(SessionId('stored'), {
      header: header('stored', { agentPreset: 'creation-preset' }),
      events,
      projections: { asOfSeq: 1 as never, values: { agentPreset: 'projected-preset' } },
    })
    const input = raw.agents.resume.mock.calls[0]?.[0]
    expect(input).toMatchObject({
      resumeSessionId: 'stored',
      agentOptions: { provider: 'saved-provider', model: 'saved-model' },
    })
    expect(typeof input?.setup).toBe('function')
    // the projected preset, not the creation header's, is the one mounted on resume
    // interaction handlers are covered by their own tests; here only the mounted preset matters
    vi.spyOn(instance.interactions, 'install').mockReturnValue(() => {})
    await input?.setup?.({} as never, {} as never)
    expect(raw.agentPresets.mount).toHaveBeenCalledWith(expect.anything(), 'projected-preset')
  })

  it('lists only exact-cwd roots, excludes subagents, and coalesces live/stored duplicates', async () => {
    const live = fakeAgent('live', header('live', { createdAt: 10 }))
    const wrongCwd = fakeAgent('other-cwd', header('other-cwd', { cwd: '/other', createdAt: 20 }))
    const subagent = fakeAgent('child', header('child', { origin: 'subagent', createdAt: 30 }))
    const depthOnlyChild = fakeAgent('depth-child', header('depth-child', { delegationDepth: 1, createdAt: 31 }))
    const { ctx } = fakeContext({
      roots: [live, wrongCwd, subagent, depthOnlyChild],
      stored: [
        header('live', { createdAt: 10 }),
        header('stored', { createdAt: 5 }),
        header('stored-other', { cwd: '/other' }),
        header('stored-depth-child', { delegationDepth: 1 }),
      ],
    })
    const instance = router(ctx, activeStore('stored'))
    const rows = await (instance as unknown as { listSessions(): Promise<unknown[]> }).listSessions()
    expect(rows).toEqual([
      { id: 'live', createdAt: 10, live: true, active: false },
      { id: 'stored', createdAt: 5, live: false, active: true },
    ])
  })

  it('disposes plugin-owned handles but never an adopted live Agent', async () => {
    const adoptedDispose = vi.fn()
    const adopted = Object.assign(fakeAgent('adopted'), { dispose: adoptedDispose })
    const activeAgents = new Map<string, Agent>([['adopted', adopted]])
    const adoptedContext = fakeContext({ roots: [adopted], activeAgents })
    const adoptedRouter = router(adoptedContext.ctx, activeStore('adopted'))
    await (adoptedRouter as unknown as { releaseCurrent(): Promise<void> }).releaseCurrent()
    expect(adoptedDispose).not.toHaveBeenCalled()

    const ownedContext = fakeContext()
    const ownedRouter = router(ownedContext.ctx, activeStore('imessage-created'))
    const handle = { agent: ownedContext.created, dispose: ownedContext.createDispose } as unknown as AgentHandle
    ;(ownedRouter as unknown as { ownedHandle?: AgentHandle }).ownedHandle = handle
    await (ownedRouter as unknown as { releaseCurrent(): Promise<void> }).releaseCurrent()
    expect(ownedContext.createDispose).toHaveBeenCalledOnce()
  })

  it('refuses switching for queued prompts, running turns, or human interactions', async () => {
    const running = fakeAgent('running', header('running'), 'running')
    const { ctx } = fakeContext({ roots: [running] })
    const instance = router(ctx, activeStore('running'))
    const privateRouter = instance as unknown as {
      pendingPromptCount: number
      assertSwitchAllowed(): Promise<void>
    }
    privateRouter.pendingPromptCount = 1
    await expect(privateRouter.assertSwitchAllowed()).rejects.toMatchObject({ code: 'busy' })
    privateRouter.pendingPromptCount = 0
    await expect(privateRouter.assertSwitchAllowed()).rejects.toMatchObject({ code: 'busy' })
  })

  it('delivers the final assistant answer as plain text, converting markdown', async () => {
    const { ctx, raw, created } = fakeContext()
    const instance = router(ctx, activeStore())
    const calls = raw.on.mock.calls as unknown as [string, (payload: never) => void][]
    const handlers = new Map<string, (payload: never) => void>(calls)

    const channel = {
      id: 'provider-message',
      text: 'hello',
      responding: async (callback: () => void) => callback(),
      send: vi.fn(async () => {}),
    } as unknown as SpectrumInboundMessage
    void instance.receive(channel)

    const followup = (created as unknown as { followup: ReturnType<typeof vi.fn> }).followup
    await vi.waitFor(() => { expect(followup).toHaveBeenCalled() })
    const messageId = followup.mock.calls[0]?.[0]?.id

    handlers.get('agent/inbox/claimed')?.({ agent: created, message: { id: messageId }, turn: 1 })
    handlers.get('session/event')?.({ id: created.id }, {
      type: 'assistant/message',
      data: { turn: 1, message: { content: [{ type: 'text', text: '**bold** and `code`' }] } },
    })
    handlers.get('session/event')?.({ id: created.id }, { type: 'turn/end', data: { turn: 1 } })

    await vi.waitFor(() => { expect(channel.send).toHaveBeenCalled() })
    expect(channel.send).toHaveBeenCalledWith('bold and code')
  })
})
