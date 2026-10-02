import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';

export function NotFound({ inline = false }: { inline?: boolean }) {
  const body = (
    <div className="container-md text-center py-6 px-3">
      <h1 className="f00-light color-fg-muted mb-2">404</h1>
      <p className="f3 mb-4">This is not the web page you are looking for.</p>
      <Link to="/" className="btn">
        Go to your dashboard
      </Link>
    </div>
  );
  if (inline) return body;
  return (
    <>
      <Header />
      {body}
    </>
  );
}
