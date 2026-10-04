import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PeopleIcon, MailIcon, OrganizationIcon } from '@primer/octicons-react';
import { api, qk } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Header } from '@/components/Header';
import { Avatar } from '@/components/Avatar';
import { CopyButton } from '@/components/CopyButton';
import { Spinner } from '@/components/Spinner';

export default function Admin() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const members = useQuery({ queryKey: qk.members, queryFn: api.members });
  const invites = useQuery({
    queryKey: qk.invitations,
    queryFn: api.invitations,
  });
  const [showInvite, setShowInvite] = useState(params.get('invite') === '1');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [result, setResult] = useState<{
    url: string;
    emailed: boolean;
    email: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => api.invite({ email, role }),
    onSuccess: (r) => {
      setResult({
        url: r.inviteUrl,
        emailed: r.emailed,
        email: r.invitation.email,
      });
      setEmail('');
      qc.invalidateQueries({ queryKey: qk.invitations });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invitations }),
  });
  const team = useQuery({ queryKey: qk.team, queryFn: api.team });
  const [teamForm, setTeamForm] = useState<{
    name: string;
    slug: string;
  } | null>(null);
  const [teamMsg, setTeamMsg] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const saveTeam = useMutation({
    mutationFn: () => api.saveTeam(teamForm!),
    onSuccess: (r) => {
      setTeamMsg({
        kind: 'success',
        text: `Saved. Team repositories live at /${r.team.slug}/<repo>.`,
      });
      setTeamForm(null);
      qc.invalidateQueries({ queryKey: qk.team });
      qc.invalidateQueries({ queryKey: qk.repos });
    },
    onError: (e) => setTeamMsg({ kind: 'error', text: errorMessage(e) }),
  });
  const pending = (invites.data ?? []).filter(
    (i) => !i.acceptedAt && new Date(i.expiresAt) > new Date()
  );

  return (
    <>
      <Header context={<span className="text-bold px-2">Site admin</span>} />
      <div className="container-lg px-3 py-4">
        <div className="Subhead">
          <h2
            className="Subhead-heading d-flex flex-items-center"
            style={{ gap: 8 }}
          >
            <OrganizationIcon size={24} /> Team
          </h2>
          <div className="Subhead-description">
            The one shared team. Its repositories are visible to every member,
            and live at{' '}
            <code>/{team.data?.team?.slug ?? '<team>'}/&lt;repo&gt;</code>.
          </div>
        </div>
        {teamMsg && (
          <div className={`flash flash-${teamMsg.kind} mb-3`}>
            {teamMsg.text}
          </div>
        )}
        {teamForm ? (
          <form
            className="Box p-3 mb-5 d-flex flex-wrap flex-items-end"
            style={{ gap: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              setTeamMsg(null);
              saveTeam.mutate();
            }}
          >
            <div className="flex-1">
              <label className="d-block f6 text-bold mb-1">Team name</label>
              <input
                className="form-control width-full"
                required
                placeholder="XY Space"
                value={teamForm.name}
                onChange={(e) =>
                  setTeamForm({ ...teamForm, name: e.target.value })
                }
              />
            </div>
            <div className="flex-1">
              <label className="d-block f6 text-bold mb-1">URL name</label>
              <input
                className="form-control width-full input-monospace"
                required
                placeholder="xyspace"
                value={teamForm.slug}
                onChange={(e) =>
                  setTeamForm({ ...teamForm, slug: e.target.value })
                }
              />
            </div>
            <button className="btn btn-primary" disabled={saveTeam.isPending}>
              Save team
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setTeamForm(null)}
            >
              Cancel
            </button>
            {team.data?.team && teamForm.slug !== team.data.team.slug && (
              <p className="f6 color-fg-attention width-full mb-0">
                Changing the URL name changes every team repository's URL and
                clone address.
              </p>
            )}
          </form>
        ) : (
          <div
            className="Box p-3 mb-5 d-flex flex-items-center"
            style={{ gap: 12 }}
          >
            {team.data?.team ? (
              <>
                <Avatar
                  user={{ username: team.data.team.slug }}
                  size={32}
                  square
                />
                <div className="flex-1">
                  <Link
                    to={`/${team.data.team.slug}`}
                    className="text-bold color-fg-default"
                  >
                    {team.data.team.name}
                  </Link>
                  <div className="f6 color-fg-muted text-mono">
                    /{team.data.team.slug}
                  </div>
                </div>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    setTeamForm({
                      name: team.data!.team!.name,
                      slug: team.data!.team!.slug,
                    })
                  }
                >
                  Rename
                </button>
              </>
            ) : (
              <>
                <div className="flex-1 color-fg-muted">
                  No team yet. Create it to allow team repositories.
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => setTeamForm({ name: '', slug: '' })}
                >
                  Create team
                </button>
              </>
            )}
          </div>
        )}

        <div className="Subhead">
          <h2
            className="Subhead-heading d-flex flex-items-center"
            style={{ gap: 8 }}
          >
            <PeopleIcon size={24} /> Members
          </h2>
          <div className="Subhead-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setShowInvite(!showInvite)}
            >
              Invite member
            </button>
          </div>
        </div>
        {showInvite && (
          <form
            className="Box p-3 mb-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              setResult(null);
              invite.mutate();
            }}
          >
            <h3 className="f4 mb-1">Invite a member</h3>
            <p className="f6 color-fg-muted mb-3">
              They'll receive an email with a link to create their account. The
              link expires in 7 days.
            </p>
            {error && <div className="flash flash-error mb-3">{error}</div>}
            {result && (
              <div
                className={`flash ${result.emailed ? 'flash-success' : 'flash-warn'} mb-3`}
              >
                <p className="mb-2">
                  {result.emailed
                    ? `Invitation sent to ${result.email}. You can also share this link directly:`
                    : `We couldn't send the email to ${result.email}. Share this link with them instead:`}
                </p>
                <div className="input-group">
                  <input
                    className="form-control input-monospace input-sm"
                    readOnly
                    value={result.url}
                  />
                  <div className="input-group-button">
                    <CopyButton text={result.url} />
                  </div>
                </div>
              </div>
            )}
            <div
              className="d-flex flex-wrap flex-items-end"
              style={{ gap: 12 }}
            >
              <div className="flex-1">
                <label className="d-block f6 text-bold mb-1">
                  Email address
                </label>
                <input
                  type="email"
                  required
                  className="form-control width-full"
                  placeholder="teammate@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="d-block f6 text-bold mb-1">Role</label>
                <select
                  className="form-select"
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'user' | 'admin')}
                >
                  <option value="user">Member</option>
                  <option value="admin">Site admin</option>
                </select>
              </div>
              <button className="btn btn-primary" disabled={invite.isPending}>
                {invite.isPending ? 'Sending…' : 'Send invitation'}
              </button>
            </div>
          </form>
        )}
        {members.isPending ? (
          <Spinner />
        ) : (
          <div className="Box mb-5">
            <div className="Box-header">
              <h3 className="Box-title">{members.data!.length} members</h3>
            </div>
            {members.data!.map((m) => (
              <div
                key={m.id}
                className="Box-row d-flex flex-items-center"
                style={{ gap: 12 }}
              >
                <Avatar user={m} size={32} />
                <div className="flex-1" style={{ minWidth: 0 }}>
                  <Link
                    to={`/${m.username}`}
                    className="text-bold color-fg-default"
                  >
                    {m.username}
                  </Link>
                  <span className="color-fg-muted ml-2">{m.name}</span>
                  <div
                    className="f6 color-fg-muted"
                    style={{ overflowWrap: 'anywhere' }}
                  >
                    {m.email}
                  </div>
                </div>
                {/* Stacked on the right so the name and email keep the width on phones. */}
                <div
                  className="d-flex flex-column flex-items-end flex-shrink-0"
                  style={{ gap: 4 }}
                >
                  {m.role === 'admin' && (
                    <span className="Label Label--accent">Site admin</span>
                  )}
                  <span className="f6 color-fg-muted no-wrap">
                    Joined {timeAgo(m.createdAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="Subhead">
          <h2
            className="Subhead-heading d-flex flex-items-center"
            style={{ gap: 8 }}
          >
            <MailIcon size={24} /> Pending invitations
          </h2>
        </div>
        {pending.length === 0 ? (
          <p className="color-fg-muted">No pending invitations.</p>
        ) : (
          <div className="Box">
            {pending.map((i) => (
              <div
                key={i.id}
                className="Box-row d-flex flex-items-center"
                style={{ gap: 12 }}
              >
                <MailIcon className="color-fg-muted" />
                <div className="flex-1">
                  <div className="text-bold">{i.email}</div>
                  <div className="f6 color-fg-muted">
                    Invited {timeAgo(i.createdAt)} · expires{' '}
                    {timeAgo(i.expiresAt)}
                  </div>
                </div>
                <span className="Label">
                  {i.role === 'admin' ? 'Site admin' : 'Member'}
                </span>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => revoke.mutate(i.id)}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
