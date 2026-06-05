# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in ClauTime, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email security concerns to the maintainers privately. You can reach us through GitHub by opening a [private security advisory](https://github.com/lookitstony/clautime/security/advisories/new).

We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Scope

ClauTime is a local desktop application. Security concerns include:

- Credential storage (API keys stored via Electron safeStorage)
- Secret scanner bypass (patterns that should be detected but aren't)
- Local data exposure (session data, JSONL file handling)
- Electron security (CSP, preload script isolation, IPC validation)

## Security Design

- **All data stays local** — no telemetry, no network calls except optional AI summaries
- **API keys** are encrypted using Electron's `safeStorage` (OS keychain)
- **Secret scanner** detects 50+ patterns of leaked credentials in Claude Code JSONL files
- **No remote database** — SQLite stored in user's AppData directory
