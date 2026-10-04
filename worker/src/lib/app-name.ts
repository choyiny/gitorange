export const DEFAULT_APP_NAME = 'GitOrange';

/** App name as an MCP server id: "XY Space Git" → "xy-space-git". */
export function mcpServerName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'gitorange'
  );
}
