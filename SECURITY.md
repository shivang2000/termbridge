# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in termbridge, **please do not open a
public GitHub issue**. Instead, report it privately:

- **Preferred:** use GitHub's [Report a vulnerability](https://github.com/shivang2000/termbridge/security/advisories/new)
  flow (Security → Advisories → New draft advisory).
- **Fallback:** email the maintainer (see the GitHub profile for `shivang2000`).

Please include:
- a description of the issue and its impact,
- the minimum steps to reproduce it,
- any suggested fix or mitigation.

We will acknowledge receipt as soon as practical and coordinate a fix + disclosure timeline with
you. Please do not publicly disclose the issue until a fix is released.

## Scope

termbridge's security model centers on its **session-piloting control plane** — every `send_text`
is equivalent to remote command execution on the host/container the session runs in. The relevant
attack surface is the unified server (`@termbridge/server`), the MCP proxy (`@termbridge/mcp-server`
proxy mode), and the tool surface they expose.

### Built-in defenses

- **Loopback bind by default.** The server binds `127.0.0.1` unless `HOST` explicitly opts out; a
  non-loopback bind prints a startup warning.
- **Bearer token (constant-time compared)** gates the HTTP tool API, the `/login` route, and the
  WebSocket (`?token=` or `Authorization: Bearer`). A missing token config means "unauthenticated"
  (tests only).
- **Origin allowlist** on the WebSocket upgrade (CSWSH / cross-site WebSocket hijacking defence).
  Native (no-Origin) clients are always allowed; a browser Origin must be explicitly allowlisted.
- **`env: "docker"` isolation guard** — `TERMBRIDGE_ALLOWED_ENVS` can lock an untrusted caller to
  containers so a session can never execute on the host.
- **Concurrency cap** (`TERMBRIDGE_MAX_SESSIONS`) bounds fleet size.

### Threats we do NOT defend against (by design)

- **Local backend = no isolation.** `env: "local"` gives the agent full host access. Steer
  untrusted/multi-tenant use to Docker (or a future cloud sandbox). Blocklists are not a substitute
  for isolation.
- **Exposing the server beyond loopback.** If you set `HOST` to a non-loopback address, the token +
  Origin allowlist are your only barriers. Run it behind your own auth/TLS first.
- **Token handling by the operator.** The token is a credential. Keep it out of shell history,
  committed env files, and logs. Server-to-server callers (the MCP proxy, `engineer.ts`) send it via
  the `Authorization` header; the browser WebSocket uses `?token=` (browsers cannot set WS headers),
  so treat watch URLs as secrets.

## Responsible use (subscription terms)

Automating a subscription CLI (e.g. driving `claude` with an agent) may conflict with the provider's
terms of service and can put your account at risk. termbridge **does not implement, and will not
accept**, any detection-evasion features (humanized keystroke timing, account rotation, fingerprint
spoofing). Cap concurrency, understand your plan's terms, and use this at your own risk. See
[Responsible use](README.md#responsible-use) in the README.
