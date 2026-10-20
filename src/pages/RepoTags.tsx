import { Link, useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { TagIcon } from '@primer/octicons-react';
import { api, qk, type RepoDetail } from '@/lib/uiApi';
import { shortSha } from '@/lib/format';
import { QueryError, RowsSkeleton } from '@/components/actions/states';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHead } from '@/components/ui/PageHead';

/**
 * Tags (`/:owner/:repo/tags`): every git tag, newest name first, with the commit it points at and the release it
 * is. Tags pushed with git are listed too; only tags GitOrange cut have a release.
 */
export default function RepoTags() {
  const repo = useOutletContext<RepoDetail>();
  const o = repo.owner.username;
  const base = `/${repo.fullName}`;
  const q = useQuery({
    queryKey: qk.tags(o, repo.name),
    queryFn: () => api.tags(o, repo.name),
  });
  const tags = q.data;
  return (
    <>
      <PageHead
        icon="tag"
        crumbs={[
          { label: 'Releases', to: `${base}/releases` },
          { label: 'Tags' },
        ]}
        title="Tags"
        tab="releases"
        lede="Every tag in the repository. A tag pushed with git is listed too, but only a release GitOrange cut counts as a version."
        actions={
          <Link to={`${base}/releases`} className="btn">
            Releases
          </Link>
        }
      />
      {q.isError && !tags ? (
        <div className="panel">
          <QueryError
            error={q.error}
            onRetry={() => void q.refetch()}
            title="The tags did not load"
          />
        </div>
      ) : !tags ? (
        <RowsSkeleton rows={4} />
      ) : tags.length === 0 ? (
        <div className="panel">
          <EmptyState
            picture={<TagIcon size={24} />}
            title="No tags yet"
            body="Cutting a release tags the default branch; tags pushed with git show up here too."
          />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table rel-tags">
            <caption className="sr">Tags</caption>
            <thead>
              <tr>
                <th scope="col">Tag</th>
                <th scope="col">Commit</th>
                <th scope="col">Release</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((t) => (
                <tr key={t.name}>
                  <td>
                    <span className="rel-tag-name mono">
                      <TagIcon size={14} />
                      {t.name}
                    </span>
                  </td>
                  <td>
                    <Link to={`${base}/commit/${t.sha}`} className="mono">
                      {shortSha(t.sha)}
                    </Link>
                  </td>
                  <td>
                    {t.release ? (
                      <Link
                        to={`${base}/releases/${encodeURIComponent(t.release)}`}
                      >
                        {t.release}
                      </Link>
                    ) : (
                      <span className="muted small">Pushed with git</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
