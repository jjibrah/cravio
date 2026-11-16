import { NavLink } from 'react-router-dom';
import Icon from '../Icon';
import { dashboards } from '../../config/dashboards';
import NotificationCenter from '../notifications/NotificationCenter';
import RefreshButton from '../RefreshButton';
import GlobalSearch from '../search/GlobalSearch';

/* The one place the product says it is showing layout previews. */
export function PreviewChip() {
  return <span className="preview-chip" tabIndex={0} aria-describedby="preview-chip-tip">
    <span className="preview-chip-dot" aria-hidden="true" />Preview
    <span role="tooltip" id="preview-chip-tip" className="preview-chip-tip">Pages show their layout until live data is connected.</span>
  </span>;
}

export default function TopNav({ account, scope, onOpenSidebar }) {
  const contact = dashboards[scope.area]?.contact;
  return <header className="dashboard-topnav">
    <button className="icon-button mobile-nav-toggle" onClick={onOpenSidebar} aria-label="Open navigation" aria-controls="mobile-sidebar"><Icon name="bars" /></button>
    <div className="topnav-search"><GlobalSearch role={scope.area} base={scope.base} placeId={scope.place?.id} /></div>
    <div className="topnav-end">
      <PreviewChip />
      <div className="topnav-actions">
        {contact && <NavLink to={`${scope.base}/${contact.path}`} aria-label={contact.label} title={contact.label}
          className={({ isActive }) => `icon-button topnav-contact${isActive ? ' is-active' : ''}`}><Icon name="complaints" size={18} /></NavLink>}
        <RefreshButton /><NotificationCenter />
      </div>
    </div>
  </header>;
}
