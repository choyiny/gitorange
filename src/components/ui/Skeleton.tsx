/** Page-shaped placeholders for the first visit to a route; revisits paint at once. */
export type SkeletonKind = 'list' | 'detail' | 'graph' | 'overview';

const sk = (cls: string, key?: number) => (
  <div key={key} className={`sk ${cls}`} />
);
const repeat = (n: number, cls: string) =>
  Array.from({ length: n }, (_, i) => sk(cls, i));

export function Skeleton({ kind = 'overview' }: { kind?: SkeletonKind }) {
  return (
    <div
      className="sk-page"
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      {sk('sk-line w20')}
      {sk('sk-title')}
      {kind === 'list' && (
        <>
          {sk('sk-line w50')}
          <div className="sk-rows">{repeat(6, 'sk-row')}</div>
        </>
      )}
      {kind === 'detail' && (
        <div className="sk-cols">
          <div className="sk-rows">{repeat(3, 'sk-row tall')}</div>
          {sk('sk-side')}
        </div>
      )}
      {kind === 'graph' && (
        <>
          {sk('sk-block short')}
          {sk('sk-block')}
        </>
      )}
      {kind === 'overview' && (
        <>
          {sk('sk-line w50')}
          {sk('sk-block short')}
          <div className="sk-grid">{repeat(3, 'sk-card')}</div>
        </>
      )}
    </div>
  );
}
