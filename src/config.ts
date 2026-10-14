import s from '@deepseek-ai/schemastery'

/** Production Photon management and authentication origin. */
export const DEFAULT_PHOTON_API_ORIGIN = 'https://app.photon.codes'

/** Host-only operational configuration. */
export interface Config {
  /** Photon API origin; production by default. */
  photonApiOrigin?: string
  /** Human-interaction timeout in milliseconds. */
  interactionTimeoutMs?: number
  /** Maximum Unicode-safe outbound iMessage chunk length. */
  maxOutboundChars?: number
  /** Number of DSH sessions shown per `/sessions` page. */
  sessionsPerPage?: number
  /** Maximum durable inbound message ids retained. */
  dedupeEntries?: number
  /** Initial Spectrum reconnect delay in milliseconds. */
  reconnectMinMs?: number
  /** Maximum Spectrum reconnect delay in milliseconds. */
  reconnectMaxMs?: number
}

/** Fully resolved host-only operational configuration. */
export interface ResolvedConfig {
  /** Canonical Photon API origin. */
  photonApiOrigin: string
  /** Human-interaction timeout in milliseconds. */
  interactionTimeoutMs: number
  /** Maximum Unicode-safe outbound iMessage chunk length. */
  maxOutboundChars: number
  /** Number of DSH sessions shown per `/sessions` page. */
  sessionsPerPage: number
  /** Maximum durable inbound message ids retained. */
  dedupeEntries: number
  /** Initial Spectrum reconnect delay in milliseconds. */
  reconnectMinMs: number
  /** Maximum Spectrum reconnect delay in milliseconds. */
  reconnectMaxMs: number
}

/**
 * User-editable settings fields. DSH 0.2 has no `settings.register`: the plugin entry's own
 * Config is the settings section, and `volatile()` fields are the ones the Settings UI and
 * `ctx.settings.update` may write live.
 */
export const PluginSettingsFields = {
  phoneNumber: s.string().volatile(),
  assignedPhoneNumber: s.string().volatile(),
  photonUserId: s.string().volatile(),
}

/** Cordis plugin config schema: host-only options plus the volatile user settings. */
export const Config = s.object({
  ...PluginSettingsFields,
  photonApiOrigin: s.string().default(DEFAULT_PHOTON_API_ORIGIN),
  interactionTimeoutMs: s.number().step(1).min(1_000).default(600_000),
  maxOutboundChars: s.number().step(1).min(256).default(3_500),
  sessionsPerPage: s.number().step(1).min(1).max(20).default(5),
  dedupeEntries: s.number().step(1).min(64).max(8_192).default(1_024),
  reconnectMinMs: s.number().step(1).min(100).default(1_000),
  reconnectMaxMs: s.number().step(1).min(1_000).default(60_000),
})

/** Resolve and cross-validate host-only config. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const raw = config.photonApiOrigin ?? DEFAULT_PHOTON_API_ORIGIN
  const url = new URL(raw)
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('photonApiOrigin must use HTTPS (HTTP is allowed only for loopback tests)')
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('photonApiOrigin must be an origin without a path, query, or fragment')
  }
  const reconnectMinMs = config.reconnectMinMs ?? 1_000
  const reconnectMaxMs = config.reconnectMaxMs ?? 60_000
  if (reconnectMaxMs < reconnectMinMs) {
    throw new Error('reconnectMaxMs must be greater than or equal to reconnectMinMs')
  }
  return {
    photonApiOrigin: url.origin,
    interactionTimeoutMs: config.interactionTimeoutMs ?? 600_000,
    maxOutboundChars: config.maxOutboundChars ?? 3_500,
    sessionsPerPage: config.sessionsPerPage ?? 5,
    dedupeEntries: config.dedupeEntries ?? 1_024,
    reconnectMinMs,
    reconnectMaxMs,
  }
}

/** Non-secret user settings stored by DSH. */
export interface PluginSettings {
  /** Configured sender E.164 number. */
  phoneNumber?: string
  /** Assigned Photon-hosted line. */
  assignedPhoneNumber?: string
  /** Public Photon Spectrum user id. */
  photonUserId?: string
}
