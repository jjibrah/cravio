import './page-skeleton.css';

/**
 * In-app navigation placeholder while a page's code loads: a light outline of a page (title, purpose
 * line, two panels) inside the shell, so the sidebar and top bar never disappear. It fades in after a
 * short delay, so fast loads show nothing at all. `variant="waiter"` matches the waiter's tile screens.
 */
export default function PageSkeleton({ variant = 'page' }) {
  if (variant === 'waiter') {
    return <div className="page-skeleton is-waiter" role="status" aria-label="Loading page">
      <span className="sk page-skeleton-title" aria-hidden="true" />
      <span className="sk sk-line page-skeleton-sub" aria-hidden="true" />
      <div className="page-skeleton-tiles" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <span key={i} className="page-skeleton-tile" />)}</div>
    </div>;
  }
  return <div className="page-skeleton" role="status" aria-label="Loading page">
    <span className="sk page-skeleton-title" aria-hidden="true" />
    <span className="sk sk-line page-skeleton-sub" aria-hidden="true" />
    <div className="page-skeleton-grid" aria-hidden="true">
      <span className="page-skeleton-card is-main"><span className="sk sk-text" style={{ width: '32%' }} /><span className="sk sk-line" style={{ width: '58%' }} /><span className="sk sk-line" style={{ width: '44%' }} /></span>
      <span className="page-skeleton-card"><span className="sk sk-text" style={{ width: '48%' }} /><span className="sk sk-line" style={{ width: '70%' }} /></span>
    </div>
  </div>;
}
