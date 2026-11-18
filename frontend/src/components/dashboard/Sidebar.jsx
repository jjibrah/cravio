import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { dashboards, groupSections, settingsSection, visibleSections } from '../../config/dashboards';
import { useInventoryEnabled } from '../../lib/inventory';
import Brand from '../Brand';
import Icon from '../Icon';
import ProfileMenu from './ProfileMenu';
import PlaceSummary from './PlaceSummary';
import BranchSwitcher from './BranchSwitcher';

function SidebarLink({ to, icon, label, onNavigate, exact = false }) {
  // Only the overview link needs an exact match; others stay active on their detail pages
  // (unless another entry lives under them: Stock at /inventory beside Items at /inventory/items).
  return <NavLink end={exact || to.split('/').length <= 2} to={to} onClick={onNavigate} className={({ isActive }) => `sidebar-link${isActive ? ' is-active' : ''}`}>
    <span className="nav-icon"><Icon name={icon} size={16} /></span><span>{label}</span>
  </NavLink>;
}

function SidebarContent({ account, scope, onNavigate, mobile, onClose }) {
  const config = dashboards[scope.area];
  const { base } = scope;
  const branchArea = scope.area === 'branch';
  const inventory = useInventoryEnabled(scope.area).enabled;
  const sections = visibleSections(config.sections, { inventory });
  return <>
    <div className="sidebar-brand">
      <Brand to={base} onClick={onNavigate} label={`Cravio ${config.label.toLowerCase()} home`} />
      {mobile && <button className="icon-button sidebar-close" onClick={onClose} aria-label="Close navigation"><Icon name="close" /></button>}
    </div>
    {branchArea && <PlaceSummary place={scope.place} settingsPath={`${base}/settings`} onNavigate={onNavigate} />}
    <nav className="sidebar-navigation" aria-label={`${config.label} navigation`}>
      {groupSections(sections).map((group, index) => <div className="sidebar-group" key={group.label || index}>
        {group.label && <p className="sidebar-group-label">{group.label}</p>}
        {group.sections.map((section) => <SidebarLink key={section.path} to={`${base}${section.path ? `/${section.path}` : ''}`}
          icon={section.icon} label={section.label} onNavigate={onNavigate}
          exact={sections.some((other) => other.path.startsWith(`${section.path}/`))} />)}
        {branchArea && group.label === 'Menu' && <a className="sidebar-link guest-menu-link" href={`/guest-menu?r=${scope.place.id}`} target="_blank" rel="noopener noreferrer" onClick={onNavigate}>
          <span className="nav-icon"><Icon name="qr" size={16} /></span><span>Guest menu</span><Icon name="external" size={13} className="guest-menu-external" />
        </a>}
      </div>)}
      {/* Other places this account works: after the area's own navigation, so it never outranks it. */}
      {scope.area !== 'admin' && <BranchSwitcher account={account} scope={scope} onNavigate={onNavigate} />}
    </nav>
    <div className="sidebar-footer">
      {scope.area !== 'owner' && <SidebarLink to={`${base}/${settingsSection.path}`} icon={settingsSection.icon} label={settingsSection.label} onNavigate={onNavigate} />}
      <ProfileMenu account={account} onNavigate={onNavigate} />
    </div>
  </>;
}

export default function Sidebar({ account, scope, open, onClose }) {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 800px)').matches);
  const dialogRef = useRef(null);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 800px)');
    const change = () => setMobile(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!mobile || !dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [mobile, open]);

  const content = <SidebarContent account={account} scope={scope} mobile={mobile} onClose={onClose} onNavigate={onClose} />;
  return mobile ? <dialog ref={dialogRef} className="sidebar sidebar-drawer" id="mobile-sidebar" aria-label="Navigation"
    onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const targets = [...event.currentTarget.querySelectorAll('a[href], button:not([disabled])')]
        .filter((element) => element.getClientRects().length > 0);
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="sidebar-inner">{content}</div>
  </dialog> : <aside className="sidebar" aria-label="Sidebar"><div className="sidebar-inner">{content}</div></aside>;
}
