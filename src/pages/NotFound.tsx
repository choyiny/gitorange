import { Link } from 'react-router-dom';
import { usePageHead, type PageHeadInfo } from '@/components/ui/PageHead';

/** The top band for a page that doesn't exist (or that the person can't see). */
export const NOT_FOUND_HEAD: PageHeadInfo = {
  icon: 'alert',
  crumbs: [{ label: 'Page not found' }],
  title: 'Page not found',
};

/**
 * 404, inside the shell (and inside a repository's header when the repository exists). It is also what a person
 * sees for a page they may not open, so it never says which.
 */
export function NotFound() {
  usePageHead(NOT_FOUND_HEAD);
  return (
    <section className="notfound" aria-labelledby="not-found-title">
      <p className="nf-code mono" aria-hidden="true">
        404
      </p>
      <h2 id="not-found-title">This page does not exist</h2>
      <p>
        This is not the web page you are looking for. It may have moved, or you
        may not have access to it.
      </p>
      <div className="actions">
        <Link to="/" className="btn primary">
          Go home
        </Link>
        <Link to="/repos" className="btn">
          Browse repositories
        </Link>
      </div>
    </section>
  );
}
