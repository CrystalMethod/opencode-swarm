# Empty-scope task completion

Verification-only tasks that explicitly declare `files_touched: []` can now complete when the trusted coder settlement proves that no mutation was accepted. The completion and read-only gate-status paths use the same durable evidence, preserve independent advisory gates, and keep ordinary or malformed scopes fail-closed.

No configuration or migration is required. Existing tasks and terminal WAL records remain backward-compatible; only an authoritative empty-scope/no-mutation settlement may use the new path.
