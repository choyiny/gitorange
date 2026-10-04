import { useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GearIcon, PeopleIcon } from '@primer/octicons-react';
import { api, qk, type RepoDetail } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { Avatar } from '@/components/Avatar';
import { NotFound } from './NotFound';

export default function RepoSettings() {
  const repo = useOutletContext<RepoDetail>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const o = repo.owner.username;
  const [name, setName] = useState(repo.name);
  const [description, setDescription] = useState(repo.description ?? '');
  const [defaultBranch, setDefaultBranch] = useState(repo.defaultBranch);
  const [flash, setFlash] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const [collabName, setCollabName] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const collabs = useQuery({
    queryKey: qk.collaborators(o, repo.name),
    queryFn: () => api.collaborators(o, repo.name),
  });
  const members = useQuery({ queryKey: qk.members, queryFn: api.members });

  const save = useMutation({
    mutationFn: () =>
      api.updateRepo(o, repo.name, { name, description, defaultBranch }),
    onSuccess: async (r) => {
      setFlash({ kind: 'success', text: 'Repository settings saved.' });
      await qc.invalidateQueries({ queryKey: ['repo', o] });
      await qc.invalidateQueries({ queryKey: qk.repos });
      if (r.name !== repo.name) navigate(`/${o}/${r.name}/settings`);
    },
    onError: (e) => setFlash({ kind: 'error', text: errorMessage(e) }),
  });
  const changeVisibility = useMutation({
    mutationFn: (visibility: 'private' | 'internal') =>
      api.updateRepo(o, repo.name, { visibility }),
    onSuccess: async (r) => {
      setFlash({
        kind: 'success',
        text: `This repository is now ${r.visibility}.`,
      });
      await qc.invalidateQueries({ queryKey: ['repo', o] });
      await qc.invalidateQueries({ queryKey: qk.repos });
    },
    onError: (e) => setFlash({ kind: 'error', text: errorMessage(e) }),
  });
  const addCollab = useMutation({
    mutationFn: (u: string) => api.addCollaborator(o, repo.name, u),
    onSuccess: () => {
      setCollabName('');
      qc.invalidateQueries({ queryKey: qk.collaborators(o, repo.name) });
    },
    onError: (e) => setFlash({ kind: 'error', text: errorMessage(e) }),
  });
  const removeCollab = useMutation({
    mutationFn: (u: string) => api.removeCollaborator(o, repo.name, u),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: qk.collaborators(o, repo.name) }),
  });
  const del = useMutation({
    mutationFn: () => api.deleteRepo(o, repo.name),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.repos });
      navigate('/');
    },
    onError: (e) => setFlash({ kind: 'error', text: errorMessage(e) }),
  });

  if (!repo.permissions.admin) return <NotFound inline />;
  const existing = new Set([
    repo.owner.id,
    ...(collabs.data ?? []).map((c) => c.id),
  ]);
  const candidates = (members.data ?? []).filter((m) => !existing.has(m.id));

  return (
    <div
      className="container-xl px-3 px-md-4 px-lg-5 pb-6 d-flex flex-column flex-md-row"
      style={{ gap: 24 }}
    >
      <nav className="menu col-md-3" style={{ height: 'fit-content' }}>
        <a
          href="#general"
          className="menu-item selected d-flex flex-items-center"
          style={{ gap: 8 }}
        >
          <GearIcon /> General
        </a>
        <a
          href="#access"
          className="menu-item d-flex flex-items-center"
          style={{ gap: 8 }}
        >
          <PeopleIcon /> Collaborators
        </a>
      </nav>
      <div className="flex-1">
        {flash && (
          <div className={`flash flash-${flash.kind} mb-3`}>{flash.text}</div>
        )}
        <div className="Subhead" id="general">
          <h2 className="Subhead-heading">General</h2>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFlash(null);
            save.mutate();
          }}
        >
          <label className="d-block text-bold f6 mb-1">Repository name</label>
          <div className="d-flex mb-3" style={{ gap: 8 }}>
            <input
              className="form-control"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <label className="d-block text-bold f6 mb-1">Description</label>
          <input
            className="form-control width-full mb-3"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <label className="d-block text-bold f6 mb-1">Default branch</label>
          <select
            className="form-select mb-3"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            disabled={!repo.branches.length}
          >
            {repo.branches.length === 0 && (
              <option>{repo.defaultBranch}</option>
            )}
            {repo.branches.map((b) => (
              <option key={b.name}>{b.name}</option>
            ))}
          </select>
          <div>
            <button className="btn" disabled={save.isPending}>
              Save changes
            </button>
          </div>
        </form>

        <div className="Subhead mt-6" id="access">
          <h2 className="Subhead-heading">Collaborators</h2>
          <div className="Subhead-description">
            {repo.visibility === 'private'
              ? 'Collaborators can see this private repository, push branches, and merge pull requests.'
              : 'Every member can read this repository. Collaborators can also push branches and merge pull requests.'}
          </div>
        </div>
        <div className="Box mb-3">
          <div className="Box-row d-flex flex-items-center" style={{ gap: 12 }}>
            <Avatar user={repo.owner} size={32} />
            <Link to={`/${o}`} className="text-bold flex-1">
              {o}
            </Link>
            <span className="Label">Owner</span>
          </div>
          {(collabs.data ?? []).map((u) => (
            <div
              key={u.id}
              className="Box-row d-flex flex-items-center"
              style={{ gap: 12 }}
            >
              <Avatar user={u} size={32} />
              <Link to={`/${u.username}`} className="text-bold flex-1">
                {u.username}
              </Link>
              <span className="Label">Write</span>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => removeCollab.mutate(u.username)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <form
          className="d-flex mb-6"
          style={{ gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (collabName) addCollab.mutate(collabName);
          }}
        >
          <select
            className="form-select flex-1"
            value={collabName}
            onChange={(e) => setCollabName(e.target.value)}
          >
            <option value="">Select a member…</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.username}>
                {m.username} — {m.name}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!collabName}>
            Add collaborator
          </button>
        </form>

        <div className="Subhead mt-6" id="visibility">
          <h2 className="Subhead-heading">Visibility</h2>
          <div className="Subhead-description">
            {repo.ownerType === 'team'
              ? 'Team repositories are always visible to every member.'
              : repo.visibility === 'private'
                ? 'Private: only you, collaborators, and site admins can see this repository.'
                : 'Internal: every member of this instance can see this repository.'}
          </div>
        </div>
        {repo.ownerType === 'user' && (
          <div className="mb-6">
            <button
              className="btn"
              disabled={changeVisibility.isPending}
              onClick={() =>
                changeVisibility.mutate(
                  repo.visibility === 'private' ? 'internal' : 'private'
                )
              }
            >
              {repo.visibility === 'private' ? 'Make internal' : 'Make private'}
            </button>
          </div>
        )}

        <div className="Subhead">
          <h2 className="Subhead-heading color-fg-danger">Danger Zone</h2>
        </div>
        <div className="Box color-border-danger">
          <div className="Box-row">
            <div className="text-bold">Delete this repository</div>
            <p className="f6 color-fg-muted mb-2">
              Once you delete a repository, there is no going back. Type{' '}
              <strong>{repo.fullName}</strong> to confirm.
            </p>
            <div className="d-flex flex-column flex-sm-row" style={{ gap: 8 }}>
              <input
                className="form-control flex-1"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
              />
              <button
                className="btn btn-danger"
                disabled={confirmName !== repo.fullName || del.isPending}
                onClick={() => del.mutate()}
              >
                Delete this repository
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
