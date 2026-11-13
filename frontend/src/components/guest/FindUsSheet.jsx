import GuestSheet from '../menu/GuestSheet';
import { openStatus, weekHours } from '../../lib/format';

/** "Find us": address with a maps link, phone, and the week's opening hours with today marked. */
export default function FindUsSheet({ open, onClose, restaurant, contained }) {
  const place = [restaurant?.address, restaurant?.area].filter(Boolean).join(', ');
  const query = encodeURIComponent([restaurant?.name, restaurant?.address || restaurant?.area].filter(Boolean).join(', '));
  const week = weekHours(restaurant?.openingHours);
  const status = openStatus(restaurant?.openingHours);
  const phone = restaurant?.phone;
  return <GuestSheet open={open} onClose={onClose} title="Find us" contained={contained} className="gx-find-sheet">
    <div className="gx-find">
      <section className="gx-find-place" aria-label="Address">
        <span className="gx-find-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11Z" /><circle cx="12" cy="10" r="2.5" /></svg></span>
        <div>
          <p className="gx-find-name">{restaurant?.name}</p>
          <p className="gx-muted">{place || 'Ask a member of staff for directions.'}</p>
        </div>
      </section>
      <div className="gx-find-actions">
        {query && <a className="gx-primary" href={`https://www.google.com/maps/search/?api=1&query=${query}`} target="_blank" rel="noopener noreferrer">Open in Maps<span className="visually-hidden"> (opens in a new tab)</span></a>}
        {phone && <a className="gx-secondary" href={`tel:${phone.replace(/[^\d+]/g, '')}`}>Call {phone}</a>}
      </div>
      {week.length > 0 && <section aria-labelledby="gx-hours">
        <h3 id="gx-hours" className="gx-eyebrow">Opening hours{status && <span className={`gx-open${status.open ? ' is-open' : ''}`}>{status.label}</span>}</h3>
        <table className="gx-hours">
          <tbody>{week.map((day) => <tr key={day.key} className={day.today ? 'is-today' : undefined} aria-current={day.today ? 'date' : undefined}>
            <th scope="row">{day.name}{day.today && <span className="visually-hidden"> (today)</span>}</th><td>{day.text}</td>
          </tr>)}</tbody>
        </table>
      </section>}
    </div>
  </GuestSheet>;
}
