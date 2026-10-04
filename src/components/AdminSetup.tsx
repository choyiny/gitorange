import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  AlertFillIcon,
  CheckCircleFillIcon,
  ChecklistIcon,
  LinkExternalIcon,
  SyncIcon,
  XCircleFillIcon,
} from '@primer/octicons-react';
import { errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import {
  testAiGateway,
  useSetupChecks,
  type SetupCheck,
  type SetupStatus,
} from '@/lib/setupChecks';
import { CopyButton } from './CopyButton';
import { Spinner } from './Spinner';

function StatusIcon({ status }: { status: SetupStatus }) {
  if (status === 'error')
    return <XCircleFillIcon className="color-fg-danger" aria-label="Error" />;
  if (status === 'warning')
    return (
      <AlertFillIcon className="color-fg-attention" aria-label="Warning" />
    );
  return <CheckCircleFillIcon className="color-fg-success" aria-label="OK" />;
}

function AiGatewayTest() {
  const test = useMutation({ mutationFn: testAiGateway });
  return (
    <div className="mt-2">
      <button
        className="btn btn-sm"
        disabled={test.isPending}
        onClick={() => test.mutate()}
      >
        {test.isPending ? 'Testing…' : 'Test'}
      </button>
      <span className="f6 color-fg-muted ml-2">
        Sends one tiny Workers AI request (a few tokens) through the gateway.
      </span>
      {test.data && (
        <div
          className={`flash ${test.data.ok && (test.data.logged || !test.data.gateway) ? 'flash-success' : 'flash-warn'} mt-2 f6`}
        >
          {test.data.detail}
        </div>
      )}
      {test.error && (
        <div className="flash flash-error mt-2 f6">
          {errorMessage(test.error)}
        </div>
      )}
    </div>
  );
}

function CheckRow({ check }: { check: SetupCheck }) {
  return (
    <div className="Box-row d-flex" style={{ gap: 12 }}>
      <div className="pt-1 flex-shrink-0">
        <StatusIcon status={check.status} />
      </div>
      <div className="flex-1" style={{ minWidth: 0 }}>
        <div className="d-flex flex-wrap flex-items-center" style={{ gap: 8 }}>
          <span
            className="text-bold text-mono"
            style={{ overflowWrap: 'anywhere' }}
          >
            {check.title}
          </span>
          <span className="Label">{check.category}</span>
        </div>
        <div className="f6 color-fg-muted mt-1">{check.detail}</div>
        {check.fix.length > 0 && check.status !== 'ok' && (
          <div className="mt-2">
            <div className="f6 text-bold mb-1">How to fix</div>
            <ol className="f6 pl-3">
              {check.fix.map((s, i) => (
                <li key={i} className="mb-2">
                  {s.text}
                  {s.link && (
                    <>
                      {' '}
                      <a href={s.link} target="_blank" rel="noreferrer">
                        Open dashboard <LinkExternalIcon size={12} />
                      </a>
                    </>
                  )}
                  {s.code && (
                    <div
                      className="d-flex flex-items-start mt-1 color-bg-subtle border rounded-2"
                      style={{ gap: 4 }}
                    >
                      <pre
                        className="flex-1 p-2 text-mono f6 m-0"
                        style={{ overflowX: 'auto', whiteSpace: 'pre' }}
                      >
                        {s.code}
                      </pre>
                      <CopyButton
                        text={s.code}
                        className="btn-octicon m-1"
                        label="Copy command"
                      />
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
        {check.status === 'ok' && check.fix.some((s) => s.link) && (
          <div className="f6 mt-1">
            {check.fix.map((s, i) =>
              s.link ? (
                <a key={i} href={s.link} target="_blank" rel="noreferrer">
                  {s.text.replace(/:$/, '')} <LinkExternalIcon size={12} />
                </a>
              ) : null
            )}
          </div>
        )}
        {check.id === 'ai-gateway' && <AiGatewayTest />}
      </div>
    </div>
  );
}

/** Site admin → Setup: misconfigured secrets, bindings, and variables, with steps to fix. */
export function AdminSetup() {
  const setup = useSetupChecks();
  const [showOk, setShowOk] = useState(false);
  const checks = setup.data?.checks ?? [];
  const problems = checks.filter((c) => c.status !== 'ok');
  const ok = checks.filter((c) => c.status === 'ok');
  const counts = setup.data?.counts;
  return (
    <section id="setup" className="mb-5">
      <div className="Subhead">
        <h2
          className="Subhead-heading d-flex flex-items-center"
          style={{ gap: 8 }}
        >
          <ChecklistIcon size={24} /> Setup
        </h2>
        <div className="Subhead-actions">
          <button
            className="btn btn-sm d-inline-flex flex-items-center"
            style={{ gap: 4 }}
            disabled={setup.isFetching}
            onClick={() => setup.refetch()}
          >
            <SyncIcon /> {setup.isFetching ? 'Checking…' : 'Re-check'}
          </button>
        </div>
        <div className="Subhead-description">
          This deployment's secrets, bindings, and variables. Secret values are
          never shown; only whether they're set.
        </div>
      </div>
      {setup.isPending ? (
        <Spinner />
      ) : setup.error ? (
        <div className="flash flash-error">
          Couldn't run the checks: {errorMessage(setup.error)}
        </div>
      ) : (
        <>
          <div
            className={`flash ${counts!.error ? 'flash-error' : counts!.warning ? 'flash-warn' : 'flash-success'} mb-3 d-flex flex-wrap flex-items-center`}
            style={{ gap: 12 }}
          >
            <span className="text-bold flex-1">
              {counts!.error
                ? `${counts!.error} error${counts!.error === 1 ? '' : 's'} to fix`
                : counts!.warning
                  ? 'No errors; some features are off or misconfigured'
                  : 'Everything is set up'}
            </span>
            <span className="f6">
              {counts!.error} errors · {counts!.warning} warnings · {counts!.ok}{' '}
              OK · checked {timeAgo(setup.data!.checkedAt)}
            </span>
          </div>
          {problems.length > 0 && (
            <div className="Box mb-3">
              {problems.map((c) => (
                <CheckRow key={c.id} check={c} />
              ))}
            </div>
          )}
          <div className="Box">
            <button
              type="button"
              className="Box-header d-flex flex-items-center width-full text-left border-0"
              style={{ gap: 8, cursor: 'pointer' }}
              aria-expanded={showOk}
              onClick={() => setShowOk(!showOk)}
            >
              <CheckCircleFillIcon className="color-fg-success" />
              <span className="Box-title flex-1">
                {ok.length} check{ok.length === 1 ? '' : 's'} passed
              </span>
              <span className="f6 color-fg-muted">
                {showOk ? 'Hide' : 'Show'}
              </span>
            </button>
            {showOk && ok.map((c) => <CheckRow key={c.id} check={c} />)}
          </div>
        </>
      )}
    </section>
  );
}
