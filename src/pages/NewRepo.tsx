import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LockIcon, RepoIcon } from '@primer/octicons-react';
import { api, qk, type Visibility } from '@/lib/uiApi';
import { useCurrentUser } from '@/lib/auth';
import { errorMessage } from '@/lib/api';
import { Header } from '@/components/Header';
import { Avatar } from '@/components/Avatar';

export default function NewRepo() {
  const user = useCurrentUser()!;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [addReadme, setAddReadme] = useState(false);
  const [params] = useSearchParams();
  const team =
    useQuery({ queryKey: qk.team, queryFn: api.team }).data?.team ?? null;
  const [owner, setOwner] = useState<'user' | 'team'>(
    params.get('owner') === 'team' ? 'team' : 'user'
  );
  const [visibility, setVisibility] = useState<Visibility>('private');
  const forTeam = owner === 'team' && !!team;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const normalized = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const repo = await api.createRepo({
        name,
        description: description || undefined,
        addReadme,
        owner: forTeam ? 'team' : 'user',
        visibility,
      });
      await qc.invalidateQueries({ queryKey: qk.repos });
      navigate(`/${repo.fullName}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <>
      <Header />
      <div className="container-md px-3 py-5" style={{ maxWidth: 768 }}>
        <div className="pb-2 mb-3 border-bottom">
          <h1 className="f2 text-normal">Create a new repository</h1>
          <p className="color-fg-muted f5 mt-1">
            A repository contains all project files, including the revision
            history. Already have a project repository elsewhere? Push it here
            after creating an empty repository.
          </p>
        </div>
        <p className="f6 color-fg-muted fst-italic mb-3">
          Required fields are marked with an asterisk (*).
        </p>
        {error && <div className="flash flash-error mb-3">{error}</div>}
        <form onSubmit={submit}>
          <div className="d-flex flex-items-end mb-3" style={{ gap: 8 }}>
            <div>
              <label htmlFor="owner" className="d-block mb-1 text-bold f6">
                Owner *
              </label>
              <div className="d-flex flex-items-center" style={{ gap: 6 }}>
                <Avatar
                  user={
                    forTeam
                      ? { username: team!.slug }
                      : { username: user.username ?? user.name }
                  }
                  size={20}
                  square={forTeam}
                />
                <select
                  id="owner"
                  className="form-select"
                  value={forTeam ? 'team' : 'user'}
                  onChange={(e) => setOwner(e.target.value as 'user' | 'team')}
                  disabled={!team}
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
            </div>
            <span className="f2 color-fg-muted pb-1">/</span>
            <div className="flex-1">
              <label
                htmlFor="repository_name"
                className="d-block mb-1 text-bold f6"
              >
                Repository name *
              </label>
              <input
                id="repository_name"
                className="form-control width-full"
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>
          {name && normalized !== name && (
            <p className="f6 color-fg-attention mb-3">
              Your new repository will be created as{' '}
              <strong>{normalized}</strong>.
            </p>
          )}
          <p className="f6 color-fg-muted mb-3">
            Great repository names are short and memorable.
          </p>
          <div className="mb-3">
            <label htmlFor="description" className="d-block mb-1 text-bold f6">
              Description{' '}
              <span className="text-normal color-fg-muted">(optional)</span>
            </label>
            <input
              id="description"
              className="form-control width-full"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="border-top py-3">
            {forTeam ? (
              <div className="d-flex flex-items-start" style={{ gap: 8 }}>
                <RepoIcon size={24} className="color-fg-muted" />
                <div>
                  <div className="text-bold">Internal</div>
                  <div className="f6 color-fg-muted">
                    Team repositories are visible to every member of{' '}
                    {team!.name}. You and collaborators you add can push.
                  </div>
                </div>
              </div>
            ) : (
              (
                [
                  [
                    'private',
                    LockIcon,
                    'Private',
                    'Only you, collaborators you add, and site admins can see this repository.',
                  ],
                  [
                    'internal',
                    RepoIcon,
                    'Internal',
                    'Every member of this instance can see this repository. You and collaborators you add can push.',
                  ],
                ] as const
              ).map(([value, Icon, title, desc]) => (
                <label
                  key={value}
                  className="d-flex flex-items-start mb-2"
                  style={{ gap: 8, cursor: 'pointer' }}
                >
                  <input
                    type="radio"
                    name="visibility"
                    className="mt-1"
                    checked={visibility === value}
                    onChange={() => setVisibility(value)}
                  />
                  <Icon size={24} className="color-fg-muted" />
                  <span>
                    <span className="d-block text-bold">{title}</span>
                    <span className="d-block f6 color-fg-muted">{desc}</span>
                  </span>
                </label>
              ))
            )}
          </div>
          <div className="border-top py-3">
            <h3 className="f5 mb-2">Initialize this repository with:</h3>
            <label className="d-flex flex-items-start" style={{ gap: 8 }}>
              <input
                type="checkbox"
                className="mt-1"
                checked={addReadme}
                onChange={(e) => setAddReadme(e.target.checked)}
              />
              <span>
                <span className="text-bold">Add a README file</span>
                <span className="d-block f6 color-fg-muted">
                  This is where you can write a long description for your
                  project.
                </span>
              </span>
            </label>
          </div>
          <div className="border-top pt-3 d-flex flex-justify-end">
            <button className="btn btn-primary" disabled={busy || !name.trim()}>
              {busy ? 'Creating repository…' : 'Create repository'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
