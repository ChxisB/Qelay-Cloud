export const EMBEDDED_CONFIG = `{
  "mcpServers": {
    "qelay": {
      "command": "bun",
      "args": ["/absolute/path/qelay-mcp-runtime/node_modules/.bin/qelay-mcp"],
      "env": { "DATA_PATH": "./data/qelay.db" }
    }
  }
}`;

export const TCP_CONFIG = `{
  "mcpServers": {
    "qelay": {
      "command": "bun",
      "args": ["/absolute/path/qelay-mcp-runtime/node_modules/.bin/qelay-mcp"],
      "env": {
        "QELAY_MODE": "tcp",
        "QELAY_HOST": "localhost",
        "QELAY_PORT": "6789",
        "QELAY_TOKEN": "your-token"
      }
    }
  }
}`;

export const CLI_ADD =
  'claude mcp add qelay -- bun /absolute/path/qelay-mcp-runtime/node_modules/.bin/qelay-mcp';
