# Git provider authentication

Repository preparation resolves the requester's routed credential and uses the actual token only in the provider request. Tokens are never persisted or logged. The proposal stores only a digest of the credential route; execution readiness fails if that route changes.
