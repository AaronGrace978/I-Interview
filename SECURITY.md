# Security and release scope

Report security issues privately to the repository owner through GitHub's private vulnerability reporting when enabled. Do not post provider keys or private resumes in public issues.

The renderer has no Node API, cannot supply arbitrary request destinations, and uses a validated native bridge. Resume PDFs are parsed locally with current PDF.js. Provider keys are encrypted using Electron safeStorage with Linux `basic_text` explicitly rejected. Upload limits, stream bounds, fixed HTTPS origins, redirect refusal, timeouts, main-frame IPC validation, and cancellation limit common failure modes. These controls have not undergone an independent security assessment.

Model prompts and factual grounding are instructions, not a security boundary or a factual guarantee. Treat model output as untrusted text and supervise it. Generated output is rendered as React text rather than HTML. Never use this application to conceal AI participation or fabricate credentials.

Before production distribution, complete live-provider and audio tests with consented data; verify native key storage on Windows, macOS, and Linux; test packaged microphone permissions; review model data-retention settings; validate signed/notarized installers and a real upgrade; and review dependency advisories. Keep release credentials in protected GitHub environments and require review for release workflow changes.

Local exports can contain personal information. Clearing local state does not revoke provider-side retention or delete cloned voices; delete those through the provider or the in-app voice-deletion action before discarding the reference.
