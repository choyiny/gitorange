import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qk } from './uiApi';

const DEFAULT_NAME = 'GitOrange';

/**
 * The instance's display name (the worker's `APP_NAME` var). It arrives with the setup status the
 * app already loads on start, so it is usually cached by the time a page renders.
 */
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
