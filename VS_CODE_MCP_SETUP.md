# VS Code MCP Setup

This repo already contains the MCP server package under [src/mcp-servers](src/mcp-servers). To run the plan inside VS Code, you need two things:

1. The server package must be runnable from the workspace.
2. VS Code must be told how to launch each server.

Open the workspace file at [HTF4.0.code-workspace](HTF4.0.code-workspace) rather than the root folder if you want both the app and the MCP package available in one VS Code session.

## Requirements

- VS Code with MCP support enabled for Copilot Chat.
- GitHub Copilot / Copilot Chat installed and signed in.
- Node.js 18 or newer.
- Dependencies installed in [src/mcp-servers/package.json](src/mcp-servers/package.json).
- The repo opened as a VS Code workspace so absolute paths can be resolved.
- A local metrics endpoint for [src/mcp-servers/prometheus.js](src/mcp-servers/prometheus.js), or a mock server that responds to `/metrics?service=...`.
- A Git repository with deploy tags if you want [src/mcp-servers/git.js](src/mcp-servers/git.js) to return meaningful deployment history.
- Permissions for the filesystem root used by [src/mcp-servers/filesystem.js](src/mcp-servers/filesystem.js), if you want it to scan infra files.

## Runtime Inputs

These environment variables control the servers at runtime:

- `REPO_PATH` for the git server.
- `INFRA_ROOT` for the filesystem server.
- `MEMORY_PATH` for the memory server.
- `METRICS_URL` for the metrics server.

The memory server also expects [src/mcp-servers/incident_memory/history.json](src/mcp-servers/incident_memory/history.json) to exist. The seed script already creates it.

## What Changes For VS Code

The MCP servers themselves do not need rewrites. What changes is the launcher configuration in VS Code:

- Each server should be started as a stdio process.
- The command should be `node`.
- The working directory should be [src/mcp-servers](src/mcp-servers).
- Each server gets its own entry point: `topology.js`, `prometheus.js`, `git.js`, `memory.js`, `policy.js`, and `filesystem.js`.

If your VS Code build exposes MCP server registration through settings or a command palette UI, add all six servers there. If it uses an extension-based provider, register the same six stdio definitions through `vscode.lm.registerMcpServerDefinitionProvider`.

The repo also includes [.vscode/tasks.json](.vscode/tasks.json), [.vscode/start-mcp-server.sh](.vscode/start-mcp-server.sh), and [.vscode/mcp.env.example](.vscode/mcp.env.example) so you can start all six servers from the Task Runner while you finish wiring MCP into the editor.

To use ngrok, copy [.vscode/mcp.env.example](.vscode/mcp.env.example) to [.vscode/mcp.env](.vscode/mcp.env) and replace `METRICS_URL` with your public ngrok metrics URL.

## Updated Plan

1. Install Node dependencies in [src/mcp-servers](src/mcp-servers).
2. Seed the incident memory with [src/mcp-servers/seed-memory.js](src/mcp-servers/seed-memory.js).
3. Register the six stdio servers in VS Code.
4. Restart VS Code or reload the window.
5. Verify the tools appear in Copilot Chat.
6. Point the metrics server at a reachable endpoint, such as your ngrok metrics URL in [.vscode/mcp.env](.vscode/mcp.env).
7. Optionally tighten `REPO_PATH`, `INFRA_ROOT`, and `MEMORY_PATH` for your machine.

## Recommended VS Code Launch Shape

Use one server per process. A typical server definition looks like this:

```json
{
  "label": "topology-mcp",
  "command": "node",
  "args": ["topology.js"],
  "cwd": "/Users/vishruth/Projects/HTF4.0/src/mcp-servers",
  "env": {
    "REPO_PATH": "/Users/vishruth/Projects/HTF4.0",
    "INFRA_ROOT": "/Users/vishruth/Projects/HTF4.0/infra",
    "MEMORY_PATH": "/Users/vishruth/Projects/HTF4.0/src/mcp-servers/incident_memory/history.json",
    "METRICS_URL": "http://localhost:3001"
  }
}
```

Repeat the same pattern for the other five server entry points.

## Validation Checklist

- `node src/mcp-servers/topology.js` starts without syntax errors.
- `node src/mcp-servers/prometheus.js` can reach the metrics endpoint.
- `node src/mcp-servers/git.js` runs inside a Git repo with deploy tags.
- `node src/mcp-servers/memory.js` can read and write the incident history file.
- `node src/mcp-servers/policy.js` returns allowed and blocked actions correctly.
- `node src/mcp-servers/filesystem.js` can scan the configured infra root.

If you want a faster setup, copy [.vscode/mcp.env.example](.vscode/mcp.env.example) to [.vscode/mcp.env](.vscode/mcp.env) and paste your ngrok URL into `METRICS_URL`.