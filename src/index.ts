import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  SettingsConflictError,
  type SettingsDescriptor,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import type { Volatile } from '@deepseek-ai/cordis'
import {
  type Domain,
  type KvTable,
} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  Config as ConfigSchema,
  resolveConfig,
  type Config,
  type PluginSettings,
  type ResolvedConfig,
} from './config.js'
import {
  parsePhotonCredential,
  serializePhotonCredential,
  type PhotonCredential,
} from './credential.js'
import { CREDENTIAL_NAME, SETTINGS_NAME } from './constants.js'
import { rememberInbound } from './dedupe.js'
import {
  authorizeDevice,
  createPhotonDeviceAuthApi,
  type DeviceCodeView,
} from './device-auth.js'
import { PluginError, publicError } from './errors.js'
import {
  createPhotonManagementApi,
  ensureDshProject,
  ensureSharedUser,
} from './photon-management.js'
import { normalizeE164 } from './phone.js'
import { SessionRouter } from './session-router.js'
import {
  createSpectrumConnection,
  SpectrumSupervisor,
  type SpectrumInboundMessage,
} from './spectrum-runtime.js'
import { pluginDomainSpec } from './storage.js'
import type {
  AuthorizationView,
  DisconnectRequest,
  ImessagePluginState,
  MutationResult,
  PhotonAccountView,
  ProvisioningView,
  RuntimeView,
  SavePhoneRequest,
} from './types.js'

export type * from './types.js'
export { normalizeE164 } from './phone.js'
export { chunkText } from './chunks.js'
export { rememberInbound } from './dedupe.js'
export { acceptsInboundMessage } from './spectrum-runtime.js'
export { parseCommand } from './commands.js'
export { presetForResume, selectionForResume } from './session-selection.js'
export { parseQuestionAnswer } from './question-answer.js'
export { TurnCorrelation } from './turn-correlation.js'
export { authorizeDevice } from './device-auth.js'
export { ensureDshProject, ensureSharedUser } from './photon-management.js'

/** Cordis plugin name. */
export const name = 'dsh-imessage'

/** Required DSH host services. */
export const inject = [
  'settings',
  'credentials',
  'storageDomain',
  'agents',
  'sessions',
  'sessionPersistence',
  'agentPresets',
  'agentDefaultModel',
  'tools',
  'approval',
  'userQuestions',
]

/** DSH non-secret settings namespace: the id of this plugin's profile entry. */
export const SETTINGS_NAMESPACE = SETTINGS_NAME as SettingsNamespace

/** Opaque Photon credential reference. */
export const PHOTON_CREDENTIAL_REF = credentialRef(CREDENTIAL_NAME)

/** Live references DSH 0.2 passes in for the schema's `volatile()` fields. */
export interface SettingsRefs {
  phoneNumber?: Volatile<string | undefined> | undefined
  assignedPhoneNumber?: Volatile<string | undefined> | undefined
  photonUserId?: Volatile<string | undefined> | undefined
}

type PluginDomain = Domain<typeof pluginDomainSpec>
type InboundTable = KvTable<string, { receivedAt: number }>

/** Host service implementing Photon provisioning, Spectrum, DSH routing, and typed RPC. */
export class DshPhotonImessageService extends TypertRemoteService {
  static inject = inject
  static Config = ConfigSchema

  private readonly config: ResolvedConfig
  private readonly settingsRefs: SettingsRefs
  private domain?: PluginDomain
  private inbound?: InboundTable
  private router?: SessionRouter
  private spectrum?: SpectrumSupervisor
  private authorizationOverride: AuthorizationView | undefined
  private provisioning: ProvisioningView = { phase: 'idle' }
  private runtime: RuntimeView = { phase: 'stopped' }
  private authController: AbortController | undefined
  private authTask: Promise<void> | undefined
  private authGeneration = 0
  private provisionTail = Promise.resolve()
  private inboundTail = Promise.resolve()

  /** Construct the host service; async resources open in Service.init. */
  constructor(ctx: Context, config: Config & SettingsRefs = {}) {
    super(ctx, 'dshPhotonImessage')
    this.config = resolveConfig(config)
    this.settingsRefs = {
      phoneNumber: config.phoneNumber,
      assignedPhoneNumber: config.assignedPhoneNumber,
      photonUserId: config.photonUserId,
    }
  }

  /** Register settings, open durable state, and resume local routing. */
  protected async [Service.init](): Promise<void> {
    // The plugin renders its own Settings > iMessage page; the generated form would let the
    // phone fields be edited without provisioning the Photon line.
    this.ctx.effect(() => this.ctx.settings.configure({ auto: false }), 'dsh-imessage.settings-page')
    const domain = await this.ctx.storageDomain.open(pluginDomainSpec)
    this.domain = domain
    this.inbound = domain.table('inbound')

    const router = new SessionRouter(this.ctx, {
      get: () => domain.global.get().activeSessionId,
      set: async activeSessionId => {
        await domain.global.set(activeSessionId === undefined ? {} : { activeSessionId })
      },
    }, {
      cwd: process.cwd(),
      sessionsPerPage: this.config.sessionsPerPage,
      maxOutboundChars: this.config.maxOutboundChars,
      interactionTimeoutMs: this.config.interactionTimeoutMs,
    })
    this.router = router

    const spectrum = new SpectrumSupervisor(createSpectrumConnection, {
      reconnectMinMs: this.config.reconnectMinMs,
      reconnectMaxMs: this.config.reconnectMaxMs,
      onState: state => {
        this.runtime = state
        router.setRuntimeHealthy(state.phase === 'listening')
      },
      onMessage: message => this.receiveSpectrumMessage(message),
    })
    this.spectrum = spectrum

    const credential = await this.resolveCredential()
    if (credential !== undefined) {
      this.provisioning = {
        phase: 'ready',
        project: { id: credential.project.id, name: credential.project.name },
      }
      const settings = this.requireSettings().get()
      if (settings.phoneNumber !== undefined && settings.assignedPhoneNumber !== undefined) {
        void spectrum.restart({
          projectId: credential.project.id,
          projectSecret: credential.project.secret,
          senderPhoneNumber: settings.phoneNumber,
          assignedPhoneNumber: settings.assignedPhoneNumber,
        })
      }
    }

    this.ctx.effect(() => async () => {
      this.authGeneration += 1
      this.authController?.abort(new DOMException('Plugin stopped', 'AbortError'))
      await spectrum.stop()
      await this.inboundTail.catch(() => {})
      await router.close()
      await domain.close()
    }, 'dsh-imessage.teardown')
  }

  /** Read the complete redacted settings-page state. */
  @Remote('getState')
  async getState(): Promise<ImessagePluginState> {
    const descriptor = this.settingsDescriptor()
    const credentialInfo = await this.ctx.credentials.describe(PHOTON_CREDENTIAL_REF)
    const credential = await this.resolveCredential(false)
    const settings = this.requireSettings().get()
    const activeSessionId = this.requireDomain().global.get().activeSessionId
    return {
      revision: descriptor.revision,
      settingsWritable: this.ctx.settings.writable,
      credentialConfigured: credentialInfo.configured,
      credentialWritable: credentialInfo.writable,
      authorization: this.authorizationView(credential),
      provisioning: this.provisioning,
      runtime: this.runtime,
      ...(settings.phoneNumber === undefined ? {} : { phoneNumber: settings.phoneNumber }),
      ...(settings.assignedPhoneNumber === undefined
        ? {}
        : { assignedPhoneNumber: settings.assignedPhoneNumber }),
      ...(activeSessionId === undefined ? {} : { activeSessionId }),
    }
  }

  /** Start Photon CLI-compatible device authorization and return once its code is available. */
  @Remote('beginAuthorization')
  async beginAuthorization(): Promise<MutationResult> {
    return this.mutation(async () => {
      await this.requireWritablePlanes()
      if (this.authTask !== undefined && this.authController === undefined) {
        throw new PluginError('busy', 'Photon authorization is already provisioning the dsh project.')
      }
      this.cancelAuthorizationInternal()
      const generation = ++this.authGeneration
      const controller = new AbortController()
      this.authController = controller
      const expectedRevision = this.settingsDescriptor().revision
      const oldCredentialValue = (await this.ctx.credentials.resolve(PHOTON_CREDENTIAL_REF))?.value

      let codeResolve!: () => void
      let codeReject!: (error: unknown) => void
      const codeReady = new Promise<void>((resolve, reject) => {
        codeResolve = resolve
        codeReject = reject
      })
      let codePublished = false
      const flow = authorizeDevice(createPhotonDeviceAuthApi(this.config.photonApiOrigin), {
        signal: controller.signal,
        onCode: (code: DeviceCodeView) => {
          if (generation !== this.authGeneration) return
          codePublished = true
          this.authorizationOverride = {
            phase: 'pending',
            userCode: code.userCode,
            verificationUri: code.verificationUri,
            ...(code.verificationUriComplete === undefined
              ? {}
              : { verificationUriComplete: code.verificationUriComplete }),
            expiresAt: code.expiresAt,
          }
          codeResolve()
        },
      })

      const task = flow.then(async result => {
        if (generation !== this.authGeneration || controller.signal.aborted) return
        this.authController = undefined
        this.authorizationOverride = {
          phase: 'authorized',
          account: result.account,
          expiresAt: result.expiresAt,
        }
        await this.enqueueProvision(() => this.completeAuthorization(
          result,
          expectedRevision,
          oldCredentialValue,
          generation,
          controller.signal,
        ))
      }).catch(error => {
        if (!codePublished) codeReject(error)
        if (generation !== this.authGeneration || isAbortError(error)) return
        const safe = publicError(error)
        this.authorizationOverride = { phase: 'failed', error: safe }
        this.provisioning = { phase: 'failed', error: safe }
      })
      this.authTask = task
      void task.then(() => {
        if (this.authTask === task) this.authTask = undefined
      })
      await codeReady
    })
  }

  /** Cancel an in-progress device authorization without changing the working config. */
  @Remote('cancelAuthorization')
  async cancelAuthorization(): Promise<MutationResult> {
    return this.mutation(async () => {
      this.cancelAuthorizationInternal()
    })
  }

  /** Provision or reuse the configured sending number with optimistic concurrency. */
  @Remote('savePhone')
  async savePhone(request: SavePhoneRequest): Promise<MutationResult> {
    return this.mutation(() => this.enqueueProvision(async () => {
      await this.requireWritablePlanes()
      this.assertRevision(request.expectedRevision)
      const phoneNumber = normalizeE164(request.phoneNumber)
      const credential = await this.requireManagementCredential()
      this.provisioning = { phase: 'user' }
      const api = createPhotonManagementApi(credential.apiOrigin, credential.accessToken)
      let prepared: Awaited<ReturnType<SpectrumSupervisor['prepare']>> | undefined
      try {
        const user = await ensureSharedUser(
          api,
          credential.project.id,
          phoneNumber,
          accountView(credential.account),
        )
        const connectionConfig = {
          projectId: credential.project.id,
          projectSecret: credential.project.secret,
          senderPhoneNumber: phoneNumber,
          assignedPhoneNumber: user.assignedPhoneNumber,
        }
        prepared = await this.requireSpectrum().prepare(connectionConfig)
        const savedSettings = {
          phoneNumber,
          assignedPhoneNumber: user.assignedPhoneNumber,
          photonUserId: user.id,
        }
        validateSettings(savedSettings)
        await this.ctx.settings.update(SETTINGS_NAMESPACE, savedSettings, request.expectedRevision)
        this.provisioning = {
          phase: 'ready',
          project: { id: credential.project.id, name: credential.project.name },
        }
        await this.requireSpectrum().activate(connectionConfig, prepared)
        prepared = undefined
      } catch (error) {
        if (prepared !== undefined) await prepared.stop().catch(() => {})
        const safe = publicError(error)
        this.provisioning = { phase: 'failed', error: safe }
        throw error
      }
    }))
  }

  /** Clear local routing/config/credentials while preserving Photon cloud resources. */
  @Remote('disconnect')
  async disconnect(request: DisconnectRequest): Promise<MutationResult> {
    return this.mutation(() => this.enqueueProvision(async () => {
      await this.requireWritablePlanes()
      this.assertRevision(request.expectedRevision)
      this.cancelAuthorizationInternal()
      const oldCredential = (await this.ctx.credentials.resolve(PHOTON_CREDENTIAL_REF))?.value
      await this.ctx.credentials.unset(PHOTON_CREDENTIAL_REF)
      try {
        await this.ctx.settings.replace(SETTINGS_NAMESPACE, {}, request.expectedRevision)
      } catch (error) {
        if (oldCredential !== undefined) await this.ctx.credentials.set(PHOTON_CREDENTIAL_REF, oldCredential)
        throw error
      }

      await this.requireSpectrum().stop()
      await this.inboundTail.catch(() => {})
      await this.requireRouter().reset()
      const table = this.requireInboundTable()
      for (const key of [...table.keys()]) await table.delete(key)
      this.authorizationOverride = undefined
      this.provisioning = { phase: 'idle' }
      this.runtime = { phase: 'stopped' }
    }))
  }

  /** Retry Spectrum using the currently provisioned project and line. */
  @Remote('retryRuntime')
  async retryRuntime(): Promise<MutationResult> {
    return this.mutation(async () => {
      const credential = await this.resolveCredential()
      const settings = this.requireSettings().get()
      if (credential === undefined || settings.phoneNumber === undefined || settings.assignedPhoneNumber === undefined) {
        throw new PluginError('runtime-failed', 'Authorize Photon and save a phone number before retrying iMessage.')
      }
      await this.requireSpectrum().restart({
        projectId: credential.project.id,
        projectSecret: credential.project.secret,
        senderPhoneNumber: settings.phoneNumber,
        assignedPhoneNumber: settings.assignedPhoneNumber,
      })
    })
  }

  private async completeAuthorization(
    result: Awaited<ReturnType<typeof authorizeDevice>>,
    expectedRevision: number,
    oldCredentialValue: string | undefined,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    assertAuthorizationActive(generation, this.authGeneration, signal)
    this.provisioning = { phase: 'project' }
    const management = createPhotonManagementApi(this.config.photonApiOrigin, result.accessToken)
    const oldCredential = await this.resolveCredential(false)
    const project = await ensureDshProject(management, oldCredential?.project.id)
    assertAuthorizationActive(generation, this.authGeneration, signal)

    const currentSettings = this.requireSettings().get()
    let nextSettings: PluginSettings | undefined
    if (currentSettings.phoneNumber !== undefined) {
      this.provisioning = { phase: 'user' }
      const user = await ensureSharedUser(
        management,
        project.id,
        currentSettings.phoneNumber,
        result.account,
      )
      nextSettings = {
        phoneNumber: currentSettings.phoneNumber,
        assignedPhoneNumber: user.assignedPhoneNumber,
        photonUserId: user.id,
      }
    }
    assertAuthorizationActive(generation, this.authGeneration, signal)

    const credential: PhotonCredential = {
      version: 1,
      apiOrigin: this.config.photonApiOrigin,
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.expiresAt,
      account: result.account,
      project: { id: project.id, name: project.name, secret: project.secret },
    }
    const connectionConfig = nextSettings?.phoneNumber === undefined
      || nextSettings.assignedPhoneNumber === undefined
      ? undefined
      : {
        projectId: project.id,
        projectSecret: project.secret,
        senderPhoneNumber: nextSettings.phoneNumber,
        assignedPhoneNumber: nextSettings.assignedPhoneNumber,
      }
    const prepared = connectionConfig === undefined
      ? undefined
      : await this.requireSpectrum().prepare(connectionConfig)
    try {
      await this.ctx.credentials.set(PHOTON_CREDENTIAL_REF, serializePhotonCredential(credential))
      // Even an authorization with no phone fields performs an empty settings
      // write so the optimistic revision is checked at the serialized write
      // boundary before the new credential becomes authoritative.
      if (nextSettings !== undefined) validateSettings(nextSettings)
      await this.ctx.settings.update(SETTINGS_NAMESPACE, nextSettings ?? {}, expectedRevision)
    } catch (error) {
      if (prepared !== undefined) await prepared.stop().catch(() => {})
      if (oldCredentialValue === undefined) await this.ctx.credentials.unset(PHOTON_CREDENTIAL_REF)
      else await this.ctx.credentials.set(PHOTON_CREDENTIAL_REF, oldCredentialValue)
      throw error
    }
    assertAuthorizationActive(generation, this.authGeneration, signal)

    this.authorizationOverride = undefined
    this.provisioning = { phase: 'ready', project: { id: project.id, name: project.name } }
    if (connectionConfig !== undefined && prepared !== undefined) {
      await this.requireSpectrum().activate(connectionConfig, prepared)
    }
  }

  private async receiveSpectrumMessage(message: SpectrumInboundMessage): Promise<void> {
    const result = this.inboundTail.then(async () => {
      const table = this.requireInboundTable()
      if (!await rememberInbound(table, message.id, this.config.dedupeEntries)) return
      await this.requireRouter().receive(message)
    })
    this.inboundTail = result.catch(() => {})
    return result
  }

  private authorizationView(credential: PhotonCredential | undefined): AuthorizationView {
    if (this.authorizationOverride !== undefined) return this.authorizationOverride
    if (credential === undefined) return { phase: 'disconnected' }
    if (credential.accessTokenExpiresAt <= Date.now()) {
      return { phase: 'reauthorization-required', account: accountView(credential.account) }
    }
    return {
      phase: 'authorized',
      account: accountView(credential.account),
      expiresAt: credential.accessTokenExpiresAt,
    }
  }

  private async requireManagementCredential(): Promise<PhotonCredential> {
    const credential = await this.resolveCredential()
    if (credential === undefined || credential.accessTokenExpiresAt <= Date.now()) {
      throw new PluginError(
        'authorization-required',
        'Photon management authorization expired. Reauthorize; existing iMessage routing can continue.',
      )
    }
    return credential
  }

  private async resolveCredential(reportFailure = true): Promise<PhotonCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(PHOTON_CREDENTIAL_REF)
    if (resolved === undefined) return undefined
    try {
      const credential = parsePhotonCredential(resolved.value)
      if (credential.apiOrigin !== this.config.photonApiOrigin) {
        throw new Error('credential origin mismatch')
      }
      return credential
    } catch {
      if (reportFailure) {
        const error = publicError(new PluginError(
          'authorization-required',
          'The stored Photon credential is invalid for this API origin. Disconnect or reauthorize.',
        ))
        this.provisioning = { phase: 'failed', error }
      }
      return undefined
    }
  }

  private async requireWritablePlanes(): Promise<void> {
    if (!this.ctx.settings.writable) {
      throw new PluginError('settings-readonly', 'The active DSH settings provider is read-only.')
    }
    const info = await this.ctx.credentials.describe(PHOTON_CREDENTIAL_REF)
    if (!info.writable) {
      throw new PluginError(
        'credential-readonly',
        'The Photon credential is supplied by a read-only source. Remove that override before changing iMessage setup.',
      )
    }
  }

  private cancelAuthorizationInternal(): void {
    const controller = this.authController
    if (controller !== undefined) {
      this.authGeneration += 1
      controller.abort(new DOMException('Authorization cancelled', 'AbortError'))
      this.authController = undefined
    }
    if (this.authorizationOverride?.phase === 'pending' || this.authorizationOverride?.phase === 'failed') {
      this.authorizationOverride = undefined
    }
  }

  private assertRevision(expected: number): void {
    const actual = this.settingsDescriptor().revision
    if (actual !== expected) throw new SettingsConflictError(SETTINGS_NAMESPACE, expected, actual)
  }

  private enqueueProvision<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.provisionTail.then(operation, operation)
    this.provisionTail = result.then(() => {}, () => {})
    return result
  }

  private async mutation(operation: () => Promise<void> | void): Promise<MutationResult> {
    try {
      await operation()
      return { ok: true, state: await this.getState() }
    } catch (error) {
      return { ok: false, error: publicError(error), state: await this.getState() }
    }
  }

  private settingsDescriptor(): SettingsDescriptor {
    const descriptor = this.ctx.settings.describe({ redactSecrets: true })
      .find(candidate => candidate.ns === SETTINGS_NAMESPACE)
    if (descriptor === undefined) throw new Error('dsh-imessage settings are not registered')
    return descriptor
  }

  private requireSettings(): { get(): PluginSettings } {
    const refs = this.settingsRefs
    return {
      get: () => compact({
        phoneNumber: refs.phoneNumber?.get(),
        assignedPhoneNumber: refs.assignedPhoneNumber?.get(),
        photonUserId: refs.photonUserId?.get(),
      }),
    }
  }

  private requireDomain(): PluginDomain {
    if (this.domain === undefined) throw new Error('dsh-imessage storage is not initialized')
    return this.domain
  }

  private requireInboundTable(): InboundTable {
    if (this.inbound === undefined) throw new Error('dsh-imessage dedupe storage is not initialized')
    return this.inbound
  }

  private requireRouter(): SessionRouter {
    if (this.router === undefined) throw new Error('dsh-imessage router is not initialized')
    return this.router
  }

  private requireSpectrum(): SpectrumSupervisor {
    if (this.spectrum === undefined) throw new Error('dsh-imessage Spectrum runtime is not initialized')
    return this.spectrum
  }
}

function accountView(account: {
  id: string
  email: string
  name?: string | undefined
}): PhotonAccountView {
  return {
    id: account.id,
    email: account.email,
    ...(account.name === undefined ? {} : { name: account.name }),
  }
}

function compact(settings: Record<keyof PluginSettings, string | undefined>): PluginSettings {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)) as PluginSettings
}

function validateSettings(settings: PluginSettings): void {
  const values = [settings.phoneNumber, settings.assignedPhoneNumber, settings.photonUserId]
  const present = values.filter(value => value !== undefined).length
  if (present !== 0 && present !== values.length) {
    throw new Error('phoneNumber, assignedPhoneNumber, and photonUserId must be stored together')
  }
  if (settings.phoneNumber !== undefined) normalizeE164(settings.phoneNumber)
  if (settings.assignedPhoneNumber !== undefined) normalizeE164(settings.assignedPhoneNumber)
}

function assertAuthorizationActive(current: number, actual: number, signal: AbortSignal): void {
  if (current !== actual || signal.aborted) throw new DOMException('Authorization cancelled', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export default DshPhotonImessageService
