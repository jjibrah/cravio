import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { dashboards, groupSections, settingsSection } from '../../config/dashboards';
import Brand from '../Brand';
import Icon from '../Icon';
import ProfileMenu from './ProfileMenu';
import PlaceSummary from './PlaceSummary';

function SidebarLink({ to, icon, label, onNavigate }) {
  // Only the overview link needs an exact match; others stay active on their detail pages.
  return <NavLink end={to.split('/').length <= 2} to={to} onClick={onNavigate} className={({ isActive }) => `sidebar-link${isActive ? ' is-active' : ''}`}>
    <span className="nav-icon"><Icon name={icon} size={16} /></span><span>{label}</span>
  </NavLink>;
}

function SidebarContent({ account, onNavigate, mobile, onClose }) {
  const config = dashboards[account.role];
  const base = `/${account.role}`;
  return <>
    <div className="sidebar-brand">
      <Brand to={base} onClick={onNavigate} label={`Cravio ${config.label.toLowerCase()} home`} />
      {mobile && <button className="icon-button sidebar-close" onClick={onClose} aria-label="Close navigation"><Icon name="close" /></button>}
    </div>
    {account.role === 'owner' && <PlaceSummary place={account.place} settingsPath={`${base}/settings`} onNavigate={onNavigate} />}
    <nav className="sidebar-navigation" aria-label={`${config.label} navigation`}>
      {groupSections(config.sections).map((group, index) => <div className="sidebar-group" key={group.label || index}>
        {group.label && <p className="sidebar-group-label">{group.label}</p>}
        {group.sections.map((section) => <SidebarLink key={section.path} to={`${base}${section.path ? `/${section.path}` : ''}`}
          icon={section.icon} label={section.label} onNavigate={onNavigate} />)}
        {account.role === 'owner' && group.label === 'Menu' && <a className="sidebar-link guest-menu-link" href={account.place?.id ? `/guest-menu?r=${account.place.id}` : '/guest-menu'} target="_blank" rel="noopener noreferrer" onClick={onNavigate}>
          <span className="nav-icon"><Icon name="qr" size={16} /></span><span>Guest menu</span><Icon name="external" size={13} className="guest-menu-external" />
        </a>}
      </div>)}
    </nav>
    <div className="sidebar-footer">
      <SidebarLink to={`${base}/${settingsSection.path}`} icon={settingsSection.icon} label={settingsSection.label} onNavigate={onNavigate} />
      <ProfileMenu account={account} onNavigate={onNavigate} />
    </div>
  </>;
}

export default function Sidebar({ account, open, onClose }) {
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

  const content = <SidebarContent account={account} mobile={mobile} onClose={onClose} onNavigate={onClose} />;
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
