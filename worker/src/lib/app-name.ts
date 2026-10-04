/** `APP_NAME`, e.g. "GitOrange". */
export function appName(env: Pick<CloudflareBindings, 'APP_NAME'>): string {
  return env.APP_NAME?.trim() || 'GitOrange';
}

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
