import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qk } from './uiApi';

const DEFAULT_NAME = 'GitOrange';

/** The instance's display name (`APP_NAME`), from the setup status query. */
export function useAppName(): string {
  const q = useQuery({ queryKey: qk.setup, queryFn: api.setupStatus });
  return q.data?.appName || DEFAULT_NAME;
}

/** Keeps the browser tab title in step with the instance name. */
export function useDocumentTitle() {
  const name = useAppName();
  useEffect(() => {
    document.title = name;
  }, [name]);
}
