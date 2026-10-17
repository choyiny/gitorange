const USAGE = `Usage: yarn gitorange <command>

Commands:
  install    Create or update a GitOrange installation on Cloudflare
`;

export async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
