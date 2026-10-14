import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { foldRequestHeader, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'

/** The parts of a Session observation needed to reconstruct its preset. */
export interface PresetObservation {
  header: SessionHeader
  events: readonly SessionEvent[]
  projections?: ProjectionSnapshot | undefined
}

/**
 * Reconstruct the preset a stored session was last on.
 *
 * DSH 0.2 keeps the current preset in the `agentPreset` Session projection, which already
 * folds `agent-preset/selected` events over the header's initial value. A host that did not
 * project (or an older log) falls back to the header alone.
 */
export function presetForResume(observation: PresetObservation): string | undefined {
  const projected = observation.projections?.values.agentPreset
  if (typeof projected === 'string') return projected
  return observation.header.agentPreset
}

/** Select the last persisted request model, falling back to today's default. */
export function selectionForResume(
  events: readonly SessionEvent[],
  fallback: ModelSelection,
): ModelSelection {
  const config = foldRequestHeader(events)?.config
  return config === undefined
    ? fallback
    : {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    }
}
