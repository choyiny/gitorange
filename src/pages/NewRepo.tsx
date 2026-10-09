import { useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertIcon,
  CheckIcon,
  LockIcon,
  RepoIcon,
} from '@primer/octicons-react';
import { api, qk, type Visibility } from '@/lib/uiApi';
import { useCurrentUser } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { agentColor } from '@/lib/agentLook';
import {
  DESCRIPTION_MAX,
  REPO_NAME_MAX,
  inviteFailureMessage,
  normalizeRepoName,
  repoNameProblem,
} from '@/lib/newRepo';
import { PageHead } from '@/components/ui/PageHead';
import { PendingButton } from '@/components/ui/PendingButton';
import { useToast } from '@/components/ui/Toast';
import { Notice } from '@/components/Notice';
import { Avatar } from '@/components/Avatar';

const VISIBILITIES = [
  {
    value: 'private',
    Icon: LockIcon,
    title: 'Private',
    body: 'Only you, collaborators you add, and site admins can see this repository.',
  },
  {
    value: 'internal',
    Icon: RepoIcon,
    title: 'Internal',
    body: 'Every member of this instance can see this repository. You and collaborators you add can push.',
  },
] as const;

/**
 * New repository: an owner (you, or the team), a name, an optional description, who can see it, which reviewer
 * agents review it, and whether to start with a README. Creating it opens the new repository, whose empty page has the
 * steps for pushing code (and importing from GitHub).
 */
export default function NewRepo() {
  const user = useCurrentUser()!;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [params] = useSearchParams();

  const team =
    useQuery({ queryKey: qk.team, queryFn: api.team }).data?.team ?? null;
  const agents = useQuery({ queryKey: qk.agents, queryFn: api.agents });
  const crew = useMemo(
    () => (agents.data ?? []).filter((a) => !a.deletedAt),
    [agents.data]
  );

  const [owner, setOwner] = useState<'user' | 'team'>(
    params.get('owner') === 'team' ? 'team' : 'user'
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [reviewers, setReviewers] = useState<Set<string>>(new Set());
  const [addReadme, setAddReadme] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const forTeam = owner === 'team' && !!team;
  const normalized = normalizeRepoName(name);
  const problem = repoNameProblem(name);
  const tooLong = description.length > DESCRIPTION_MAX;
  const ownerLogin = forTeam ? team!.slug : (user.username ?? user.name);

  const toggleReviewer = (handle: string) =>
    setReviewers((prev) => {
      const next = new Set(prev);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !name.trim() || problem || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      const repo = await api.createRepo({
        name,
        description: description.trim() || undefined,
        addReadme,
        owner: forTeam ? 'team' : 'user',
        visibility,
      });
      // The repository exists now; reviewers are added one by one so one refusal doesn't lose the rest.
      const failed: { name: string; reason: string }[] = [];
      await Promise.all(
        crew
          .filter((a) => reviewers.has(a.username))
          .map(async (a) => {
            try {
              await api.inviteAgent(repo.owner.username, repo.name, a.username);
            } catch (err) {
              failed.push({ name: a.name, reason: errorMessage(err) });
            }
          })
      );
      await qc.invalidateQueries({ queryKey: qk.repos });
      const note = inviteFailureMessage(failed);
      if (note) toast(note, { icon: <AlertIcon size={16} /> });
      else if (reviewers.size)
        toast(
          `Created ${repo.fullName}. ${reviewers.size === 1 ? 'The reviewer starts' : 'The reviewers start'} on its first pull request.`,
          { icon: <CheckIcon size={16} /> }
        );
      navigate(`/${repo.fullName}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead
        icon="plus"
        crumbs={[
          { label: 'Repositories', to: '/repos' },
          { label: 'New repository' },
        ]}
        title="New repository"
        lede="A repository holds a project's files and their full history. Moving a project from GitHub? Create it empty: the next page has the steps, including a prompt for your AI agent."
      />
      <div className="cols">
        <div className="col">
          {error && <Notice tone="bad">{error}</Notice>}
          <form className="panel newrepo" onSubmit={submit} noValidate>
            <div className="newrepo-row">
              <div>
                <label htmlFor="nr-owner">Owner</label>
                <div className="newrepo-owner">
                  <Avatar
                    user={{ username: ownerLogin }}
                    size={24}
                    square={forTeam}
                  />
                  <select
                    id="nr-owner"
                    value={forTeam ? 'team' : 'user'}
                    onChange={(e) =>
                      setOwner(e.target.value as 'user' | 'team')
                    }
                    disabled={!team}
                    aria-describedby={team ? undefined : 'nr-owner-hint'}
                    title={
                      team
                        ? undefined
                        : 'A site admin can create the team in Site admin'
                    }
                  >
                    <option value="user">{user.username}</option>
                    {team && <option value="team">{team.slug}</option>}
                  </select>
                </div>
                {!team && (
                  <span id="nr-owner-hint" className="hint">
                    Team repositories need a team: a site admin creates it in
                    Site admin.
                  </span>
                )}
              </div>
              <div>
                <label htmlFor="nr-name">Repository name</label>
                <input
                  id="nr-name"
                  type="text"
                  required
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="for example: client-portal"
                  value={name}
                  maxLength={REPO_NAME_MAX + 20}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby="nr-name-hint"
                  onChange={(e) => setName(e.target.value)}
                />
                <span
                  id="nr-name-hint"
                  className={`hint${problem ? ' bad' : name.trim() && normalized !== name ? ' warn' : ''}`}
                  role={problem ? 'alert' : undefined}
                >
                  {problem ? (
                    problem
                  ) : name.trim() && normalized !== name ? (
                    <>
                      Your new repository will be created as{' '}
                      <strong>{normalized}</strong>.
                    </>
                  ) : (
                    'Great repository names are short and memorable.'
                  )}
                </span>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <label htmlFor="nr-desc">
                Description <span className="muted">(optional)</span>
              </label>
              <input
                id="nr-desc"
                type="text"
                autoComplete="off"
                value={description}
                aria-invalid={tooLong ? true : undefined}
                aria-describedby={tooLong ? 'nr-desc-hint' : undefined}
                onChange={(e) => setDescription(e.target.value)}
              />
              {tooLong && (
                <span id="nr-desc-hint" className="hint bad" role="alert">
                  A description can be at most {DESCRIPTION_MAX} characters.
                </span>
              )}
            </div>

            <fieldset className="newrepo-visibility">
              <legend>Who can see it</legend>
              {forTeam ? (
                <div className="fixed">
                  <RepoIcon size={20} />
                  <span>
                    <b>Internal</b>
                    <br />
                    <span className="muted small">
                      Team repositories are visible to every member of{' '}
                      {team!.name}. You and collaborators you add can push.
                    </span>
                  </span>
                </div>
              ) : (
                VISIBILITIES.map(({ value, Icon, title, body }) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="visibility"
                      checked={visibility === value}
                      onChange={() => setVisibility(value)}
                    />
                    <Icon size={20} />
                    <span>
                      <b>{title}</b>
                      <br />
                      <span className="muted small">{body}</span>
                    </span>
                  </label>
                ))
              )}
            </fieldset>

            {crew.length > 0 && (
              <fieldset className="newrepo-crew">
                <legend>Reviewer agents</legend>
                {crew.map((a) => (
                  <label key={a.username}>
                    <input
                      type="checkbox"
                      checked={reviewers.has(a.username)}
                      onChange={() => toggleReviewer(a.username)}
                    />
                    <span>
                      <span
                        className="adot"
                        style={
                          {
                            '--agent': agentColor(a.username, a.color),
                          } as CSSProperties
                        }
                      >
                        <i />
                        {a.name}
                      </span>
                      {a.bio && <span className="muted small">{a.bio}</span>}
                    </span>
                  </label>
                ))}
                <span className="hint">
                  Reviewers read each pull request they are needed on. With at
                  least one, GitOrange can merge on its own once they pass. You
                  can change this later in the repository's settings.
                </span>
              </fieldset>
            )}

            <label className="newrepo-readme">
              <input
                type="checkbox"
                checked={addReadme}
                onChange={(e) => setAddReadme(e.target.checked)}
              />
              <span>
                <b>Add a README file</b>
                <span className="muted small">
                  This is where you can write a long description for your
                  project. Moving a project from GitHub? Leave this empty.
                </span>
              </span>
            </label>

            <div className="actions">
              <PendingButton
                type="submit"
                className="primary"
                pending={busy}
                pendingLabel="Creating repository…"
                disabled={!name.trim() || !!problem || tooLong}
              >
                Create repository
              </PendingButton>
              <Link className="btn quiet" to="/repos">
                Cancel
              </Link>
            </div>
          </form>
        </div>
        <aside className="col side">
          <section className="panel pad">
            <h2>What you get</h2>
            <ul className="ticks">
              {[
                'Rebase-only merges with a safety check on main',
                'Auto-merge when checks pass and reviewers approve',
                'Actions that run your existing workflows',
                'An audit log of every merge and every decision',
              ].map((t) => (
                <li key={t}>
                  <CheckIcon size={16} className="ok" />
                  {t}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
