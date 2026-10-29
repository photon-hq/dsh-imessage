# Security policy

Report suspected credential exposure, authorization bypass, cross-user routing, or Photon resource takeover privately to the package maintainers. Do not include access tokens, project secrets, device codes, message text, or raw phone numbers in a public issue.

The project treats any npm audit finding at **high** or **critical** severity as release-blocking. The Better Auth client is pinned to `1.7.14` to use patched library dependencies. Contract tests verify that it still emits Photon’s device-login wire protocol; updating this client does not update the remote authentication service.

The Spectrum `12.7.0` dependency graph still reports moderate OpenTelemetry baggage-propagation advisories under `@photon-ai/otel`. Spectrum telemetry is explicitly disabled by this plugin, and the vulnerable telemetry packages are not configured as an inbound HTTP baggage processor here. The pinned upstream exporter versions do not yet provide a compatible dependency update that removes all affected copies. Re-evaluate this exception on every Spectrum release and remove it as soon as Photon ships patched OpenTelemetry dependencies.

Security invariants enforced by code and tests include:

- tokens, project secrets, and device codes remain host-only;
- Photon fetches reject redirects and cross-origin requests/responses;
- only the configured sender's inbound iMessage DM route is accepted; dedicated routes verify the exact assigned recipient, while shared routes rely on Photon's project-scoped delivery because Spectrum exposes only its `shared` recipient sentinel;
- authorization failures and unknown internal failures are converted to stable redacted errors;
- approvals and questions are claimed only for an exact correlated iMessage turn and fail closed when delivery is unhealthy;
- disconnect never deletes Photon cloud resources.
