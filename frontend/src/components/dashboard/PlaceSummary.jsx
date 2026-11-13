import { Link } from 'react-router-dom';
import Icon from '../Icon';

/* The restaurant this workspace belongs to. Until it has details, the card
   says so and links to where they are added, instead of showing loading bars. */
export default function PlaceSummary({ place, settingsPath, onNavigate }) {
  const name = place?.name?.trim() || '';
  const status = place?.status?.trim() || '';
  const location = place?.location?.trim() || '';

  if (!name) return <Link className="place-summary is-empty" to={settingsPath} onClick={onNavigate}>
    <span className="place-summary-avatar is-placeholder" aria-hidden="true"><Icon name="restaurants" size={16} /></span>
    <span className="place-summary-details">
      <strong className="place-summary-name">Your restaurant</strong>
      <span className="place-summary-meta">Add name and location</span>
    </span>
    <Icon name="chevron" size={14} className="place-summary-chevron" />
  </Link>;

  return <section className="place-summary" aria-label={`Restaurant: ${name}`}>
    <span className="place-summary-avatar" aria-hidden="true">{name[0].toUpperCase()}</span>
    <div className="place-summary-details">
      <strong className="place-summary-name" title={name}>{name}</strong>
      <div className="place-summary-meta">
        {status && <span className="place-summary-status" data-status={status.toLowerCase()}><span className="place-status-dot" aria-hidden="true" />{status[0].toUpperCase() + status.slice(1)}</span>}
        {location && <span className="place-summary-location" title={location}>{location}</span>}
      </div>
    </div>
  </section>;
}
