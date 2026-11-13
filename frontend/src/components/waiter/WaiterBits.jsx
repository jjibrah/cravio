import Glyph from '../media/Glyph';
import TableTile from '../tables/TableTile';
import { useLive } from './LiveProvider';

export function PageHeader({ title, subtitle, action }) {
  return <header className="waiter-page-header">
    <div className="waiter-page-title"><h1>{title}</h1>{action}</div>
    {subtitle && <p>{subtitle}</p>}
  </header>;
}

/** Quiet connection state for live screens. */
export function LiveNote() {
  const { reconnecting, error, live, refreshNow } = useLive();
  if (reconnecting) return <p className="w-live-note" role="status"><Glyph name="wifi" size={15} />Reconnecting…</p>;
  if (error && !live) {
    return <div className="w-empty"><h2>Can’t load right now</h2><p>{error.message}</p><button type="button" className="w-btn w-btn-secondary" onClick={refreshNow}>Try again</button></div>;
  }
  return null;
}

/** A grid of table tiles to choose from (plus takeaway). */
export function TablePicker({ onChoose, takeaway = true }) {
  const { live } = useLive();
  return <>
    {!live && <div className="w-tile-grid" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <span key={i} className="w-tile-skeleton" />)}</div>}
    {live && <div className="w-tile-grid" role="group" aria-label="Choose a table">
      {[...live.tables].sort((a, b) => a.number - b.number).map((t) => <TableTile key={t.id} number={t.number} state={t.state}
        label={t.state === 'bill' && !t.requestTypes?.includes('bill') ? 'Wants to pay' : undefined} onClick={() => onChoose(t.number)} />)}
    </div>}
    {takeaway && <button type="button" className="w-btn w-btn-secondary w-btn-big w-takeaway" onClick={() => onChoose('takeaway')}><Glyph name="bag" size={18} />Takeaway (no table)</button>}
  </>;
}
