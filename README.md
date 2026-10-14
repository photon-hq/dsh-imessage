# Photon iMessage for DeepSeek Harness

`dsh-imessage` adds a [Photon](https://photon.codes)-hosted iMessage transport and a **Settings → iMessage** page to the DeepSeek Harness web profile. A user authorizes Photon with device login, saves the phone number they will send from, and receives a hosted iMessage number to text. Messages from that exact route become DSH prompts and final DSH answers are sent back over iMessage.

The compatibility target is:

- DeepSeek Harness `0.2.0-rc.2` (DSH `0.1.x` is no longer supported; use an earlier release of this plugin with it)
- Spectrum `12.7.x` (the package is currently locked to `12.7.0`)
- Node.js `22.19+` or `24+`

## Install

Install the stable npm package, then start DSH from the workspace its iMessage sessions should use:

```sh
dsh plugin --profile web add dsh-imessage
dsh web
```

DSH forwards `plugin ... add` to the profile package manager. The unqualified package name follows npm's stable `latest` channel; use an explicit prerelease tag only when intentionally testing one.

If DSH is run through `npx` and `pnpm` is not installed globally, supply both tools for the install command without changing the global environment:

```sh
npx --yes --package=pnpm@10.33.0 --package=@deepseek-ai/dsh \
  -c 'dsh plugin --profile web add dsh-imessage'
npx --yes @deepseek-ai/dsh web
```

For a local checkout or packed build:

```sh
npm ci --legacy-peer-deps
npm run build
npm pack
dsh plugin --profile web add ./dsh-imessage-*.tgz
```

Open **Settings → iMessage** and complete the three cards:

1. Select **Authorize**. The browser opens a blank window immediately, then navigates it to Photon after DSH receives the device code. If popups are blocked, use the displayed link and copyable code.
2. Enter the E.164 number you will text from, such as `+14155552671`, and save it.
3. Copy or text the assigned hosted iMessage number shown in the final card.

The plugin always ensures a Photon project named exactly `dsh`. It reuses the stored accessible project first, otherwise reuses the sole exact case-sensitive match, and creates a US/iMessage project only when none exists. Multiple exact projects or users are reported with their public IDs for manual resolution; the plugin never chooses arbitrarily.

## Commands

Ordinary text is queued as a DSH prompt. Prefix a prompt that genuinely begins with `/` using `//`, for example `//review this route`.

| Command | Behavior |
|---|---|
| `/help` | Show command help. |
| `/new` | Create and select a new root session. |
| `/sessions [page]` | List same-workspace root sessions, five per page by default. |
| `/switch <index\|session-id>` | Select a listed session by index, exact ID, or unique ID prefix. |
| `/status` | Show the active session and its state. |
| `/stop` or `/cancel` | Cancel the running turn and invalidate prompts still waiting in the iMessage FIFO. |
| `/approve <request-id>` | Allow one approval request correlated to the iMessage turn. |
| `/deny <request-id>` | Reject a correlated approval request. |
| `/answer <request-id> <option-or-text>` | Answer a correlated question. Commas select multiple numbered choices. |

`/new` and `/switch` fail while an iMessage prompt is queued/running or a human interaction is pending. Send `/stop` first.

New sessions use the `dsh web` process working directory, the configured default Agent Preset, and the current default model. Session listing includes only root sessions whose `cwd` exactly matches that working directory. Subagents are excluded. A live browser-created Agent can be adopted, but the plugin never disposes an adopted Agent; it disposes only handles it created or resumed itself.

## Routing and privacy boundaries

The listener accepts only inbound text messages for which all of the following are true:

- platform is iMessage;
- direction is inbound;
- space is a direct message;
- sender equals the configured E.164 number;
- the route is the assigned hosted line: dedicated connections expose and verify the exact recipient number; shared connections are project-scoped by Photon and carry Spectrum's `shared` recipient sentinel because the provider does not expose an inbound recipient field;
- service is iMessage when the provider includes service metadata.

Unauthorized traffic is ignored without a reply. The plugin does not log message content, raw phone numbers, device codes, access tokens, or project secrets. It stores:

- non-secret phone/user/line configuration in the DSH settings namespace `dsh-imessage`;
- one atomic opaque credential at `DSH_IMESSAGE_PHOTON_CREDENTIALS`, containing the management token, public account/project identifiers, and the Spectrum project secret;
- the selected session ID and a durable bounded window of 1,024 inbound provider message IDs in the `dsh_imessage` storage domain.

The browser receives only public account/project/line metadata, authorization URLs and user code, revisions, health, and credential availability flags. Device codes and tokens stay on the host. Photon HTTP calls are pinned to one configured origin and reject redirects or cross-origin responses.

Every iMessage prompt is correlated by its exact DSH `UserMessage.id` and only becomes owned after DSH claims that message for a turn. Assistant output, approvals, and questions are forwarded only for that claimed turn. Browser-originated turns in the same adopted session remain in the browser. Approval delivery failure, an unhealthy listener, cancellation, or timeout fails closed.

Only the final assistant answer is delivered. Intermediate reasoning, tool activity, and partial output remain in DSH. Answers are converted from markdown to plain text before delivery, so formatting markers do not arrive raw over iMessage; fenced code blocks and inline code keep their exact contents. Long answers are split near paragraph, line, or word boundaries without splitting Unicode grapheme clusters. Spectrum typing state remains active while the DSH turn runs.

## Photon authorization and resources

The plugin implements Photon CLI’s current RFC 8628 device flow directly over HTTPS; it does not launch the CLI or read CLI credential files. It currently uses the CLI compatibility values `client_id=photon-cli`, scope `openid profile email`, and the standard device-code grant. Pending, `slow_down`, HTTP 429, denial, expiry, and cancellation are handled explicitly.

This shared client ID is an intentional compatibility exception. The contract fixture is pinned to Photon CLI commit [`13fb65a3f33e801cb50f7e7a240a8eb6466c4152`](https://github.com/photon-hq/cli/commit/13fb65a3f33e801cb50f7e7a240a8eb6466c4152), including [`src/commands/login.ts`](https://github.com/photon-hq/cli/blob/13fb65a3f33e801cb50f7e7a240a8eb6466c4152/src/commands/login.ts). If Photon issues a dedicated client ID for this plugin, migrate the constants and contract fixture together before changing the production flow.

Automatic user provisioning creates a **shared** Spectrum user with invitations disabled. If an exact phone user already exists, the plugin reuses it whether its allocation is shared or dedicated. If shared capacity is unavailable, setup stops with `shared-line-unavailable`; configure/resolve a dedicated line with Photon before retrying.

For shared allocations, Photon performs hosted-line routing before delivering the project-scoped stream. Spectrum 12.7 represents that route as `space.phone = "shared"`; the plugin therefore verifies the exact configured sender, direct-message shape, and iMessage service while relying on Photon's project boundary for the recipient. Dedicated allocations continue to be checked against the exact assigned hosted number.

Phone replacement is non-destructive. The new Photon user and Spectrum connection are prepared before local settings switch, and the old working listener remains active if preparation fails. Old Photon users are intentionally retained.

When the management token expires, the stored project secret can continue routing messages. Settings shows **Reauthorization required**, and project/user changes remain disabled until the user authorizes again.

**Disconnect is local only.** It stops routing and clears the local credential, settings, active-session selection, and deduplication state. It never deletes Photon projects, users, or hosted-line resources.

## Limitations

- One Photon account, one sending phone number, and one assigned hosted line per plugin instance.
- Text-only direct iMessage conversations in v1.
- Outbound answers are plain text: markdown formatting is stripped, while code blocks are preserved verbatim.
- Attachments, reactions, group chats, SMS, and RCS are ignored.
- Project name is fixed to the exact string `dsh`.
- All same-workspace root DSH sessions are visible to `/sessions` and `/switch`.
- No automatic cleanup of Photon cloud resources.

## Host configuration

Defaults are host-only and are not exposed in the settings page:

| Option | Default |
|---|---:|
| `photonApiOrigin` | `https://app.photon.codes` |
| `interactionTimeoutMs` | `600000` (10 minutes) |
| `maxOutboundChars` | `3500` graphemes |
| `sessionsPerPage` | `5` |
| `dedupeEntries` | `1024` |
| `reconnectMinMs` | `1000` |
| `reconnectMaxMs` | `60000` |

Override the bundle row in the web profile’s `cordis.patch.yml`. DSH patch overrides replace the complete row, so preserve both `id` and `name`:

```yaml
- id: dsh-imessage
  name: dsh-imessage
  config:
    interactionTimeoutMs: 900000
    maxOutboundChars: 3000
```

Non-HTTPS API origins are rejected except loopback HTTP used by tests.

## Troubleshooting

| Error | Action |
|---|---|
| `invalid-phone` | Enter `+`, a non-zero country-code digit, and at most 15 total digits. Do not include spaces or punctuation. |
| `auth-expired` / `auth-denied` | Start authorization again and complete it before the displayed expiry. |
| `authorization-required` | Reauthorize Photon; current routing may continue if the project secret is still valid. |
| `project-ambiguous` | Rename all but one exact `dsh` project in Photon, then retry. |
| `user-ambiguous` / `user-resolution-required` | Resolve duplicate/account-level phone ownership in Photon, then save again. |
| `shared-line-unavailable` | Ask Photon for shared capacity or configure a dedicated allocation. |
| `credential-readonly` / `settings-readonly` | Remove the higher-priority read-only DSH override. |
| `settings-conflict` | Another window changed settings; refresh and retry. |
| `runtime-failed` | Use **Retry listener**; if it repeats, confirm the project’s iMessage platform and hosted line in Photon. |

## Development and verification

```sh
npm ci --legacy-peer-deps
npm test
npm run build
npm pack --dry-run
# With a DSH 0.2 binary available:
DSH_BIN=/path/to/dsh npm run test:profile
```

The test suite covers device-flow backoff/cancellation, secret redaction, project/user idempotency and ambiguity, staged phone replacement, ingress filters, durable replay deduplication, reconnects, Unicode chunking, exact turn ownership, approval/question fail-closed behavior, session defaults/filtering/handle ownership, and the interactive settings UI. CI runs the suite, packed-artifact checks, and a disposable DSH web-profile installation on Node 22 and 24.

## Releasing

The [release workflow](https://github.com/photon-hq/dsh-imessage/actions/workflows/publish-npm.yml) delegates to BuildSpace's single-package TypeScript pipeline. To release, add the `release` label to a pull request before merging it into `main`. BuildSpace then determines the semantic version, generates release notes, commits the version bump, creates the GitHub Release, runs the full package check, and publishes to npm's stable `latest` channel with provenance.

For a prerelease, apply both `release` and `prerelease`; BuildSpace publishes that version to its prerelease channel instead. Unlabeled merges run normal CI but do not release. A manual dispatch can force a release for recovery. BuildSpace's `dry-run` skips npm publication only; when combined with a forced release it still creates the version commit and GitHub Release, so pull-request CI is the safe validation path.

The workflow uses npm Trusted Publishing through GitHub OIDC. Do not add a long-lived `NPM_TOKEN` solely for releases. It intentionally calls BuildSpace `main` because the immutable `v1` workflow predates OIDC support; move to the next immutable BuildSpace tag once it contains `use-oidc`.

`dsh-imessage` was bootstrapped once at `0.1.0-alpha.1`, then configured through the npm CLI with these exact Trusted Publisher values:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization | `photon-hq` |
| Repository | `dsh-imessage` |
| Workflow filename | `publish-npm.yml` |
| Environment | blank |
| Allowed action | `npm publish` |

The configuration can be inspected through the npm CLI:

```sh
npx --yes npm@11.19.0 trust list dsh-imessage
```

OIDC publishing was verified with the alpha releases, including npm's SLSA provenance attestation. The package's publishing access is set to **Require two-factor authentication and disallow tokens**, and the temporary bootstrap CLI session was logged out afterward.

Before a compatibility-target promotion, run a Photon staging smoke test with a real hosted line: authorize, create/reuse `dsh`, provision/reuse a sender, send an inbound prompt, answer an approval and question, exercise `/new`, `/sessions`, `/switch`, stop/restart DSH, confirm replay deduplication, reauthorize after token expiry, and disconnect while verifying the Photon project/users remain.

## References

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [DSH API gateway and generated Typert RPC](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/api-gateway.md)
- [Photon CLI authentication](https://photon.codes/docs/cli/authentication)
- [Spectrum TypeScript getting started](https://photon.codes/docs/spectrum-ts/getting-started)
- [Spectrum iMessage routing](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing)
