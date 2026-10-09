import { useQuery } from '@tanstack/react-query';
import { useLocation, useOutletContext } from 'react-router-dom';
import { useRepoAgent, useRepoSubPath } from '@/components/RepoLayout';
import { api, qk, type RepoDetail } from '@/lib/uiApi';
import { ApiError } from '@/lib/api';
import { usePageHead } from '@/components/ui/PageHead';
import { Skeleton } from '@/components/ui/Skeleton';
import { BlobView, LfsFileView } from '@/components/code/BlobView';
import { CodeToolbar } from '@/components/code/CodeToolbar';
import { FileTable } from '@/components/code/FileTable';
import { LoadError } from '@/components/code/LoadError';
import { QuickSetup } from '@/components/code/QuickSetup';
import { Readme } from '@/components/code/Readme';
import {
  AboutCard,
  AgentAboutCard,
  ReviewersCard,
} from '@/components/code/SideCards';
import { useEnter } from '@/components/code/useEnter';
import { NotFound } from './NotFound';

/** The top band for a code page: "Code" at the root, otherwise the directory or file being looked at. */
function CodeHead({ title, file }: { title: string; file?: boolean }) {
  usePageHead({
    icon: file ? 'file' : 'code',
    crumbs: [{ label: title }],
    title,
    tab: 'code',
  });
  return null;
}

/**
 * The code browser: the repository's home (files, README, About), a directory, or a file. An empty repository
 * shows how to fill it instead.
 */
export default function RepoCode() {
  const repo = useOutletContext<RepoDetail>();
  const o = repo.owner.username;
  const { pathname } = useLocation();
  const isBlob = pathname.split('/')[3] === 'blob';
  const treePath = useRepoSubPath('tree');
  const blobPath = useRepoSubPath('blob');
  const refPath = isBlob ? blobPath : treePath;
  const agent = useRepoAgent(o, repo.name);
  const q = useQuery({
    queryKey: qk.contents(o, repo.name, refPath),
    queryFn: () => api.contents(o, repo.name, refPath),
    enabled: !repo.empty,
  });
  const data = q.data;

  // An agent's repository has no README: its AGENT.md plays that part.
  const wantsAgentMd =
    !!agent &&
    data?.kind === 'tree' &&
    !data.path &&
    !data.readme &&
    !!data.entries?.some((e) => e.name === 'AGENT.md');
  const agentMdPath = `${data?.ref ?? ''}/AGENT.md`;
  const agentMd = useQuery({
    queryKey: qk.contents(o, repo.name, agentMdPath),
    queryFn: () => api.contents(o, repo.name, agentMdPath),
    enabled: wantsAgentMd,
  });

  const entering = useEnter(repo.empty || !!data);

  if (repo.empty || data?.kind === 'empty')
    return (
      <div className={`code-page ${entering}`}>
        <CodeHead title="Code" />
        <QuickSetup repo={repo} />
      </div>
    );
  if (q.error instanceof ApiError && q.error.status === 404)
    return <NotFound />;
  if (q.isError)
    return (
      <LoadError
        what="this page"
        error={q.error}
        onRetry={() => void q.refetch()}
        retrying={q.isFetching}
      />
    );
  if (!data) return <Skeleton kind={refPath ? 'list' : 'detail'} />;

  const atRoot = !data.path;
  const rootTree = atRoot && data.kind === 'tree';
  const agentText = agentMd.data?.file?.text;
  const readme =
    data.readme ??
    (wantsAgentMd && typeof agentText === 'string'
      ? { path: 'AGENT.md', text: agentText }
      : null);
  const name = data.path.split('/').pop() ?? '';

  return (
    <div className={`code-page ${entering}`}>
      <CodeHead title={atRoot ? 'Code' : name} file={data.kind === 'blob'} />
      {rootTree && (
        <header className="phead">
          <div className="phead-main">
            <h2 className="ph-title">{repo.name}</h2>
            <p className="lede">
              {repo.description || (
                <span className="muted">No description provided.</span>
              )}
            </p>
          </div>
        </header>
      )}
      <div className={rootTree ? 'cols' : undefined}>
        <div className="col">
          <CodeToolbar
            repo={repo}
            data={data}
            isBlob={data.kind === 'blob'}
            agentRepo={!!agent}
          />
          {data.kind === 'tree' ? (
            <>
              <FileTable repo={repo} data={data} />
              {readme && (
                <Readme repo={repo} refName={data.ref} readme={readme} />
              )}
            </>
          ) : data.file?.lfs ? (
            <LfsFileView repo={repo} data={data} />
          ) : (
            <BlobView key={data.path} repo={repo} data={data} />
          )}
        </div>
        {rootTree && (
          <aside className="col side" aria-label="About this repository">
            {agent ? (
              <AgentAboutCard agent={agent} />
            ) : (
              <>
                <AboutCard
                  repo={repo}
                  readmePath={readme?.path ?? null}
                  refName={data.ref}
                />
                <ReviewersCard repo={repo} />
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
