import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { parseCommand } from '../src/commands.js'
import { parseQuestionAnswer } from '../src/question-answer.js'
import { presetForResume, selectionForResume } from '../src/session-selection.js'

describe('iMessage commands and interactions', () => {
  it('parses commands case-insensitively while preserving // prompts', () => {
    expect(parseCommand('/SWITCH  abc-123 ')).toEqual({ name: 'switch', arguments: 'abc-123' })
    expect(parseCommand('//help')).toBeUndefined()
    expect(parseCommand('hello')).toBeUndefined()
  })

  it('supports numbered and named choices, comma-separated multi-select, and custom text', () => {
    const questions = [{
      id: 'mode',
      question: 'Mode?',
      options: [{ label: 'Fast' }, { label: 'Safe' }, { label: 'Thorough' }],
      multiSelect: true,
    }]
    expect(parseQuestionAnswer(questions, '1, Thorough')).toEqual({
      answers: [{ id: 'mode', selected: ['Fast', 'Thorough'] }],
    })
    expect(parseQuestionAnswer([{ id: 'note', question: 'Anything else?' }], 'Use staging')).toEqual({
      answers: [{ id: 'note', selected: [], custom: 'Use staging' }],
    })
  })

  it('requires every question when answering a multi-question request', () => {
    const questions = [
      { id: 'one', question: 'First?' },
      { id: 'two', question: 'Second?' },
    ]
    expect(parseQuestionAnswer(questions, '1:alpha; 2:beta')).toEqual({
      answers: [
        { id: 'one', selected: [], custom: 'alpha' },
        { id: 'two', selected: [], custom: 'beta' },
      ],
    })
    expect(() => parseQuestionAnswer(questions, '1:alpha')).toThrowError(expect.objectContaining({
      code: 'invalid-command',
    }))
  })

  it('resumes with the latest persisted request model and otherwise uses the current default', () => {
    const fallback = { provider: 'default-provider', model: 'default-model' }
    const events = [
      {
        type: 'request/header', seq: 0, time: 1,
        data: {
          header: { config: { provider: 'first', model: 'one' } },
          reason: 'initial',
        },
      },
      {
        type: 'request/header', seq: 1, time: 2,
        data: {
          header: { config: { provider: 'last', model: 'two', reasoningEffort: 'high' } },
          reason: 'change',
        },
      },
    ] as unknown as SessionEvent[]
    expect(selectionForResume(events, fallback)).toEqual({
      provider: 'last', model: 'two', reasoningEffort: 'high',
    })
    expect(selectionForResume([], fallback)).toBe(fallback)
  })

  describe('preset reconstruction (DSH 0.2 reads the agentPreset projection)', () => {
    const header = {
      version: 0,
      id: 'session' as never,
      createdAt: 0,
      delegationDepth: 0,
      agentPreset: 'original',
    }

    it('prefers the projected preset, which already folds later selections over the creation header', () => {
      expect(presetForResume({
        header,
        events: [],
        projections: { asOfSeq: 1 as never, values: { agentPreset: 'coding' } },
      })).toBe('coding')
    })

    it('falls back to the creation header when the host did not project', () => {
      expect(presetForResume({ header, events: [] })).toBe('original')
    })

    it('falls back to the creation header when the projection holds no preset', () => {
      expect(presetForResume({
        header,
        events: [],
        projections: { asOfSeq: 0 as never, values: { agentPreset: null } },
      })).toBe('original')
    })
  })
})
