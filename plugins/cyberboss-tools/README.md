# cyberboss-tools

Repo-local Claude Code plugin that exposes the Cyberboss project tool server.

The plugin is intentionally thin:

- plugin metadata lives in `.claude-plugin/plugin.json`
- tool transport lives in `.mcp.json`
- business logic stays inside the main Cyberboss repository

This keeps the tool contract project-bound instead of relying on a separately managed external registration.
