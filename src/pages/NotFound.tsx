import { Link } from 'react-router-dom';
import { usePageHead, type PageHeadInfo } from '@/components/ui/PageHead';

/** The top band for a page that doesn't exist (or that the person can't see). */
export const NOT_FOUND_HEAD: PageHeadInfo = {
  icon: 'alert',
  crumbs: [{ label: 'Page not found' }],
  title: 'Page not found',
};

/** 404, inside the shell (and inside a repository's header when the repository exists). */
export function NotFound() {
  usePageHead(NOT_FOUND_HEAD);
  return (
    <div className="container-md text-center py-6 px-3">
      <h2 className="f00-light color-fg-muted mb-2">404</h2>
      <p className="f3 mb-4">This is not the web page you are looking for.</p>
      <Link to="/" className="btn">
        Go to your dashboard
      </Link>
    </div>
  );
}
