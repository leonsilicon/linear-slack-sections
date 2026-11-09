# Security

## Credential and trust boundaries

Slack `xoxc` plus `d` cookie are powerful user-session credentials, not a narrow sidebar-only grant. Use only with account/organization approval. This tool does not acquire credentials, extract browser databases, or bypass authentication. Inject secrets locally from a trusted password manager; never paste them into chats/issues, commit them, or put them on the CLI command line. Avoid shell tracing (`set -x`) and shared environment/process inspection. Revoke exposed credentials immediately through the relevant provider's account/session controls.

Only fixed official API destinations are accepted, redirects are disabled, and transport errors omit response bodies. There is no telemetry or remote state store. Tests use fictional credentials only. Runtime uses Python stdlib; installation tooling may download setuptools. Review code and build-tool provenance before installation.

Config/state/output contain private entity/channel identifiers even without secrets: keep them in an owner-only directory outside shared or synced folders. State and lock files use 0600 on POSIX; Windows permissions require separate OS ACL management. Directory permissions and backup safety are the operator's responsibility. Use a trusted local filesystem and path; do not share state across sidebar owners. A local malicious user able to modify code/config/state or inspect your environment is outside this tool's security boundary.

No archive/delete/leave or message-reading endpoints are implemented. Apply can create channels/sections, invite the named owner, and move configured channels; it is still an external account write. Preview does network reads but never mutations. Inspect previews and use a small max_changes budget.

A crash or lost HTTP response after creation can leave a real channel without recorded state. Automatic adoption by name is intentionally refused. Inspect the provider and recover by an explicit channel-ID binding. Never remove a lock until you have confirmed the worker stopped. Do not erase state to work around an error.

## Reporting a vulnerability

Do not open a public issue containing tokens, cookies, request headers, private IDs, or unsanitized API responses. No public repository or private reporting address has been established for this local checkout. Contact the distributor through an already trusted private channel; if later published, prefer that repository's private security advisory mechanism. Describe the affected version, sanitized reproduction, expected/actual behavior and impact. No response-time guarantee is made.
