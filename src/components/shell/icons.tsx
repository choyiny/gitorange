import {
  AlertIcon,
  BookIcon,
  BroadcastIcon,
  CodeIcon,
  FileIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  GraphIcon,
  HomeIcon,
  InboxIcon,
  KeyIcon,
  MailIcon,
  PersonIcon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  PulseIcon,
  RepoIcon,
  SearchIcon,
  ShieldIcon,
  SlidersIcon,
  type Icon,
} from '@primer/octicons-react';
import type { PageIconName } from '@/lib/pageIcon';

/**
 * The crew: two robot heads with antennae (the mockup's `i-crew`), for Agents and agent repositories. Octicons
 * has no equivalent. Drawn as a stroke icon at octicon sizes.
 */
export function CrewIcon({
  size = 16,
  className,
  color,
}: {
  size?: number;
  className?: string;
  /** An agent's colour; otherwise the text colour. */
  color?: string | null;
}) {
  return (
    <svg
      className={
        className ? `octicon crew-icon ${className}` : 'octicon crew-icon'
      }
      style={color ? { color } : undefined}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="8" width="8" height="8" rx="2.5" />
      <rect x="13" y="8" width="8" height="8" rx="2.5" />
      <path d="M7 8V5M17 8V5" />
    </svg>
  );
}

const OCTICONS: Record<Exclude<PageIconName, 'crew'>, Icon> = {
  home: HomeIcon,
  repo: RepoIcon,
  inbox: InboxIcon,
  sliders: SlidersIcon,
  shield: ShieldIcon,
  plus: PlusIcon,
  person: PersonIcon,
  code: CodeIcon,
  file: FileIcon,
  pull: GitPullRequestIcon,
  commit: GitCommitIcon,
  branch: GitBranchIcon,
  play: PlayIcon,
  graph: GraphIcon,
  pulse: PulseIcon,
  live: BroadcastIcon,
  book: BookIcon,
  key: KeyIcon,
  mail: MailIcon,
  plug: PlugIcon,
  search: SearchIcon,
  alert: AlertIcon,
};

/** A page's icon by name (top band, rail, search). Decorative: say what it means in text beside it. */
export function PageIcon({
  name,
  size = 16,
}: {
  name: PageIconName;
  size?: number;
}) {
  if (name === 'crew') return <CrewIcon size={size} />;
  const Glyph = OCTICONS[name];
  return <Glyph size={size} />;
}
