/** Stable failures that are safe to render in the settings UI or iMessage. */
export type PluginErrorCode =
  | 'invalid-phone'
  | 'auth-expired'
  | 'auth-denied'
  | 'authorization-required'
  | 'project-ambiguous'
  | 'user-ambiguous'
  | 'user-resolution-required'
  | 'shared-line-unavailable'
  | 'credential-readonly'
  | 'settings-readonly'
  | 'settings-conflict'
  | 'runtime-failed'
  | 'photon-unavailable'
  | 'busy'
  | 'request-not-found'
  | 'invalid-command'
  | 'internal-error'

/** Redacted failure sent across the RPC boundary. */
export interface PublicPluginError {
  /** Stable machine-readable code. */
  code: PluginErrorCode
  /** Human-readable message containing no secrets or message content. */
  message: string
  /** Optional public identifiers needed for manual resolution. */
  details?: string[]
}

/** Public Photon identity metadata. */
export interface PhotonAccountView {
  /** Photon account id. */
  id: string
  /** Account email address. */
  email: string
  /** Display name, when Photon supplies one. */
  name?: string
}

/** Public Photon project metadata. */
export interface PhotonProjectView {
  /** Photon project id. */
  id: string
  /** Photon project name; always `dsh`. */
  name: string
}

/** Device authorization has not started. */
export interface AuthorizationDisconnected {
  /** Discriminator for a disconnected authorization state. */
  phase: 'disconnected'
}

/** Device authorization is waiting for the user. */
export interface AuthorizationPending {
  /** Discriminator for an in-progress device authorization. */
  phase: 'pending'
  /** Short code entered at Photon. */
  userCode: string
  /** Base verification page. */
  verificationUri: string
  /** Verification page with the code prefilled, when available. */
  verificationUriComplete?: string
  /** Absolute Unix expiry time in milliseconds. */
  expiresAt: number
}

/** Photon management authorization is available. */
export interface AuthorizationReady {
  /** Discriminator for a usable management authorization. */
  phase: 'authorized'
  /** Public Photon identity metadata. */
  account: PhotonAccountView
  /** Absolute Unix access-token expiry time in milliseconds. */
  expiresAt: number
}

/** Routing can continue, but management changes require device authorization. */
export interface AuthorizationRefreshRequired {
  /** Discriminator for expired management authorization. */
  phase: 'reauthorization-required'
  /** Public Photon identity metadata. */
  account: PhotonAccountView
}

/** Device authorization or its immediate account setup failed. */
export interface AuthorizationFailed {
  /** Discriminator for a failed authorization attempt. */
  phase: 'failed'
  /** Redacted authorization failure. */
  error: PublicPluginError
}

/** Complete public device-authorization state. */
export type AuthorizationView =
  | AuthorizationDisconnected
  | AuthorizationPending
  | AuthorizationReady
  | AuthorizationRefreshRequired
  | AuthorizationFailed

/** Provisioning is not currently running. */
export interface ProvisioningIdle {
  /** Discriminator for an idle provisioning state. */
  phase: 'idle'
}

/** Photon project provisioning is in progress. */
export interface ProvisioningProject {
  /** Discriminator for project provisioning. */
  phase: 'project'
}

/** Photon shared-user provisioning is in progress. */
export interface ProvisioningUser {
  /** Discriminator for user and hosted-line provisioning. */
  phase: 'user'
}

/** Photon resources needed by the plugin are ready. */
export interface ProvisioningReady {
  /** Discriminator for completed provisioning. */
  phase: 'ready'
  /** Public Photon project metadata. */
  project: PhotonProjectView
}

/** Provisioning stopped on a safe, actionable failure. */
export interface ProvisioningFailed {
  /** Discriminator for failed provisioning. */
  phase: 'failed'
  /** Redacted provisioning failure. */
  error: PublicPluginError
}

/** Complete public provisioning state. */
export type ProvisioningView =
  | ProvisioningIdle
  | ProvisioningProject
  | ProvisioningUser
  | ProvisioningReady
  | ProvisioningFailed

/** Spectrum is locally stopped. */
export interface RuntimeStopped {
  /** Discriminator for a stopped runtime. */
  phase: 'stopped'
}

/** Spectrum is starting. */
export interface RuntimeStarting {
  /** Discriminator for a starting runtime. */
  phase: 'starting'
}

/** Spectrum is actively listening for the assigned hosted line. */
export interface RuntimeListening {
  /** Discriminator for a healthy runtime. */
  phase: 'listening'
  /** Unix time in milliseconds when the listener became healthy. */
  connectedAt: number
}

/** Spectrum is waiting before an automatic reconnect. */
export interface RuntimeRetrying {
  /** Discriminator for reconnect backoff. */
  phase: 'retrying'
  /** One-based reconnect attempt. */
  attempt: number
  /** Unix time in milliseconds when the next start will be attempted. */
  retryAt: number
}

/** Spectrum exhausted or encountered a non-recoverable local failure. */
export interface RuntimeFailed {
  /** Discriminator for a failed runtime. */
  phase: 'failed'
  /** Redacted runtime failure. */
  error: PublicPluginError
}

/** Complete public Spectrum runtime state. */
export type RuntimeView =
  | RuntimeStopped
  | RuntimeStarting
  | RuntimeListening
  | RuntimeRetrying
  | RuntimeFailed

/** Complete settings-page projection. */
export interface ImessagePluginState {
  /** Monotonic DSH settings revision used for optimistic writes. */
  revision: number
  /** Whether the DSH settings provider accepts changes. */
  settingsWritable: boolean
  /** Whether a Photon credential is currently configured. */
  credentialConfigured: boolean
  /** Whether the credential provider can replace or remove the credential. */
  credentialWritable: boolean
  /** Public device-authorization state. */
  authorization: AuthorizationView
  /** Public Photon provisioning state. */
  provisioning: ProvisioningView
  /** Public Spectrum listener state. */
  runtime: RuntimeView
  /** Configured E.164 sender phone number. */
  phoneNumber?: string
  /** Photon-hosted iMessage number assigned to this sender. */
  assignedPhoneNumber?: string
  /** Active DSH root session selected for iMessage. */
  activeSessionId?: string
}

/** Optimistic request for provisioning a sender phone number. */
export interface SavePhoneRequest {
  /** Number the user will send iMessages from. */
  phoneNumber: string
  /** Settings revision observed by the browser. */
  expectedRevision: number
}

/** Optimistic request for disconnecting local plugin state. */
export interface DisconnectRequest {
  /** Settings revision observed by the browser. */
  expectedRevision: number
}

/** Successful state-changing operation. */
export interface MutationSuccess {
  /** Success discriminator. */
  ok: true
  /** Fresh public state after the operation was accepted. */
  state: ImessagePluginState
}

/** Rejected state-changing operation. */
export interface MutationFailure {
  /** Failure discriminator. */
  ok: false
  /** Redacted actionable error. */
  error: PublicPluginError
  /** Fresh public state after the failed operation. */
  state: ImessagePluginState
}

/** Result of a settings-page mutation. */
export type MutationResult = MutationSuccess | MutationFailure

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A prompt delivered over iMessage by this plugin. */
    imessage: {
      kind: 'imessage'
      plugin: string
    }
  }
}
