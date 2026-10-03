/** The instance's display name (the `APP_NAME` var), e.g. "GitOrange" or "XY Space Git". */
export function appName(env: Pick<CloudflareBindings, 'APP_NAME'>): string {
  return env.APP_NAME?.trim() || 'GitOrange';
}

/**
 * The instance name as an MCP server name: lowercase letters, digits, and dashes, the form MCP
 * clients use for server ids (`claude mcp add <name>`). "XY Space Git" → "xy-space-git".
 */
export function mcpServerName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'gitorange'
  );
}
