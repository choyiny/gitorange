/** "octocat via Claude Mod" for a decision a moderator app made over MCP; just the person for the web UI. */
export function withVia(name: string, via: string | null | undefined) {
  return via ? `${name} via ${via}` : name;
}
