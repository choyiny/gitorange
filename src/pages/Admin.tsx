import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailIcon, OrganizationIcon, PeopleIcon } from '@primer/octicons-react';
import { api, qk } from '@/lib/uiApi';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { PageHead } from '@/components/ui/PageHead';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { PendingButton } from '@/components/ui/PendingButton';
import { Section } from '@/components/ui/Section';
import { Avatar } from '@/components/Avatar';
import { CopyButton } from '@/components/CopyButton';
import { InlineConfirm } from '@/components/InlineConfirm';
import { LoadError, Notice } from '@/components/Notice';
import { AdminFrame, RowsSkeleton } from '@/components/SetFrame';
import { AdminSetup } from '@/components/AdminSetup';
import { AdminSettings } from '@/components/AdminSettings';

export default function Admin() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const members = useQuery({ queryKey: qk.members, queryFn: api.members });
  const invites = useQuery({
    queryKey: qk.invitations,
    queryFn: api.invitations,
  });
  const team = useQuery({ queryKey: qk.team, queryFn: api.team });

  // `?invite=1` (the create menu's "Invite member") opens the form, also when this page is already open.
  const wantInvite = params.get('invite') === '1';
  const [showInvite, setShowInvite] = useState(wantInvite);
  const inviteRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (wantInvite) setShowInvite(true);
  }, [wantInvite]);
  useEffect(() => {
    if (showInvite && wantInvite)
      inviteRef.current?.scrollIntoView({ block: 'nearest' });
  }, [showInvite, wantInvite]);
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
      return qc.invalidateQueries({ queryKey: qk.invitations });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invitations }),
  });

  const [teamForm, setTeamForm] = useState<{
    name: string;
    slug: string;
  } | null>(null);
  const [teamMsg, setTeamMsg] = useState<{
    kind: 'ok' | 'bad';
    text: string;
  } | null>(null);
  const saveTeam = useMutation({
    mutationFn: () => api.saveTeam(teamForm!),
    onSuccess: (r) => {
      setTeamMsg({
        kind: 'ok',
        text: `Saved. Team repositories live at /${r.team.slug}/<repo>.`,
      });
      setTeamForm(null);
      qc.invalidateQueries({ queryKey: qk.team });
      qc.invalidateQueries({ queryKey: qk.repos });
    },
    onError: (e) => setTeamMsg({ kind: 'bad', text: errorMessage(e) }),
  });
  const pending = (invites.data ?? []).filter(
    (i) => !i.acceptedAt && new Date(i.expiresAt) > new Date()
  );

  return (
    <>
      <PageHead
        icon="shield"
        crumbs={[{ label: 'Site admin' }]}
        title="Site admin"
        lede="Who can sign in, whether this deployment is set up properly, and the settings every repository shares."
      />
      <AdminFrame>
        <div id="people" className="adm-people">
          <Section
            title={
              <>
                <OrganizationIcon size={16} /> Team
              </>
            }
          >
            <p className="small muted">
              The one shared team. Its repositories are visible to every member,
              and live at{' '}
              <code>/{team.data?.team?.slug ?? '<team>'}/&lt;repo&gt;</code>.
            </p>
            {teamMsg && <Notice tone={teamMsg.kind}>{teamMsg.text}</Notice>}
            {team.isPending ? (
              <RowsSkeleton rows={1} />
            ) : team.isError ? (
              <LoadError
                what="the team"
                error={team.error}
                onRetry={() => team.refetch()}
              />
            ) : teamForm ? (
              <form
                className="panel formpad"
                onSubmit={(e) => {
                  e.preventDefault();
                  setTeamMsg(null);
                  saveTeam.mutate();
                }}
              >
                <div className="frow">
                  <div className="fld grow2">
                    <label htmlFor="team-name">Team name</label>
                    <input
                      id="team-name"
                      className="form-control"
                      required
                      placeholder="XY Space"
                      value={teamForm.name}
                      onChange={(e) =>
                        setTeamForm({ ...teamForm, name: e.target.value })
                      }
                    />
                  </div>
                  <div className="fld grow2">
                    <label htmlFor="team-slug">URL name</label>
                    <input
                      id="team-slug"
                      className="form-control mono"
                      required
                      placeholder="xyspace"
                      value={teamForm.slug}
                      onChange={(e) =>
                        setTeamForm({ ...teamForm, slug: e.target.value })
                      }
                    />
                  </div>
                </div>
                {team.data.team && teamForm.slug !== team.data.team.slug && (
                  <Notice tone="warn">
                    Changing the URL name changes every team repository&apos;s
                    URL and clone address.
                  </Notice>
                )}
                <div className="actions">
                  <PendingButton
                    type="submit"
                    className="primary"
                    pending={saveTeam.isPending}
                    pendingLabel="Saving…"
                  >
                    Save team
                  </PendingButton>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setTeamForm(null)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="panel">
                {team.data.team ? (
                  <ul className="rowlist">
                    <li>
                      <Avatar
                        user={{ username: team.data.team.slug }}
                        size={32}
                        square
                      />
                      <div className="grow">
                        <Link to={`/${team.data.team.slug}`}>
                          <b>{team.data.team.name}</b>
                        </Link>
                        <span className="mono muted small">
                          /{team.data.team.slug}
                        </span>
                      </div>
                      <div className="ctl">
                        <button
                          type="button"
                          className="btn small"
                          onClick={() =>
                            setTeamForm({
                              name: team.data.team!.name,
                              slug: team.data.team!.slug,
                            })
                          }
                        >
                          Rename
                        </button>
                      </div>
                    </li>
                  </ul>
                ) : (
                  <EmptyState
                    picture={<OrganizationIcon size={20} />}
                    title="No team yet."
                    body="Create it to allow team repositories."
                    action={
                      <button
                        type="button"
                        className="btn small primary"
                        onClick={() => setTeamForm({ name: '', slug: '' })}
                      >
                        Create team
                      </button>
                    }
                  />
                )}
              </div>
            )}
          </Section>

          <Section
            title={
              <>
                <PeopleIcon size={16} /> Members
                {members.data && (
                  <span className="num">{members.data.length}</span>
                )}
              </>
            }
            actions={
              <button
                type="button"
                className="btn small primary"
                aria-expanded={showInvite}
                onClick={() => setShowInvite(!showInvite)}
              >
                Invite member
              </button>
            }
          >
            <p className="small muted">
              Self sign-up is off. People join by invitation. Members can&apos;t
              be removed and roles can&apos;t be changed from here.
            </p>
            {showInvite && (
              <form
                ref={inviteRef}
                className="panel formpad"
                onSubmit={(e) => {
                  e.preventDefault();
                  setError(null);
                  setResult(null);
                  invite.mutate();
                }}
              >
                <h3 className="formtitle">Invite a member</h3>
                <p className="small muted">
                  They&apos;ll receive an email with a link to create their
                  account. The link expires in 7 days.
                </p>
                {error && <Notice tone="bad">{error}</Notice>}
                {result && (
                  <Notice tone={result.emailed ? 'ok' : 'warn'}>
                    <p>
                      {result.emailed
                        ? `Invitation sent to ${result.email}. You can also share this link directly:`
                        : `We couldn't send the email to ${result.email}. Share this link with them instead:`}
                    </p>
                    <div className="copyrow">
                      <input
                        className="form-control mono"
                        readOnly
                        value={result.url}
                        aria-label="Invitation link"
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <CopyButton
                        text={result.url}
                        className="btn small"
                        label="Copy the invitation link"
                      />
                    </div>
                  </Notice>
                )}
                <div className="frow">
                  <div className="fld grow2">
                    <label htmlFor="invite-email">Email address</label>
                    <input
                      id="invite-email"
                      type="email"
                      required
                      className="form-control"
                      placeholder="teammate@company.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div className="fld">
                    <label htmlFor="invite-role">Role</label>
                    <select
                      id="invite-role"
                      className="form-select"
                      value={role}
                      onChange={(e) =>
                        setRole(e.target.value as 'user' | 'admin')
                      }
                    >
                      <option value="user">Member</option>
                      <option value="admin">Site admin</option>
                    </select>
                  </div>
                  <PendingButton
                    type="submit"
                    className="primary"
                    pending={invite.isPending}
                    pendingLabel="Sending…"
                  >
                    Send invitation
                  </PendingButton>
                </div>
              </form>
            )}
            <div className="panel">
              {members.isPending ? (
                <div className="pad">
                  <RowsSkeleton rows={3} />
                </div>
              ) : members.isError ? (
                <div className="pad">
                  <LoadError
                    what="the members"
                    error={members.error}
                    onRetry={() => members.refetch()}
                  />
                </div>
              ) : (
                <ul className="rowlist">
                  {members.data.map((m) => (
                    <li key={m.id}>
                      <Avatar user={m} size={32} />
                      <div className="grow">
                        <span className="wrap">
                          <Link to={`/${m.username}`}>
                            <b>{m.username}</b>
                          </Link>{' '}
                          <span className="muted">{m.name}</span>
                        </span>
                        <span className="muted small wrap">{m.email}</span>
                      </div>
                      <div className="ctl stack">
                        {m.role === 'admin' && (
                          <Chip tone="info">Site admin</Chip>
                        )}
                        <span className="when">
                          Joined {timeAgo(m.createdAt)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Section>

          <Section
            title={
              <>
                <MailIcon size={16} /> Pending invitations
              </>
            }
          >
            {invites.isPending ? (
              <RowsSkeleton rows={1} />
            ) : invites.isError ? (
              <LoadError
                what="the invitations"
                error={invites.error}
                onRetry={() => invites.refetch()}
              />
            ) : pending.length === 0 ? (
              <div className="panel">
                <EmptyState
                  picture={<MailIcon size={20} />}
                  title="No pending invitations."
                />
              </div>
            ) : (
              <div className="panel">
                <ul className="rowlist">
                  {pending.map((i) => (
                    <li key={i.id}>
                      <MailIcon className="ic" />
                      <div className="grow">
                        <b className="wrap">{i.email}</b>
                        <span className="muted small">
                          Invited {timeAgo(i.createdAt)} · expires{' '}
                          {timeAgo(i.expiresAt)}
                        </span>
                      </div>
                      <div className="ctl">
                        <Chip tone="off">
                          {i.role === 'admin' ? 'Site admin' : 'Member'}
                        </Chip>
                        <InlineConfirm
                          label="Revoke"
                          confirmLabel="Revoke invitation"
                          pendingLabel="Revoking…"
                          accessibleName={`Revoke the invitation to ${i.email}`}
                          pending={
                            revoke.isPending && revoke.variables === i.id
                          }
                          error={
                            revoke.isError && revoke.variables === i.id
                              ? errorMessage(revoke.error)
                              : null
                          }
                          onConfirm={() => revoke.mutate(i.id)}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>
        </div>

        <AdminSetup />
        <AdminSettings />
      </AdminFrame>
    </>
  );
}
