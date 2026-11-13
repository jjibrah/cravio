import Icon from '../../components/Icon';

// Page-local glyphs in the shared stroke family (24px grid, 1.75 stroke, round joins).
// Anything not drawn here falls through to the shared Icon set.
const local = {
  more: <><circle cx="5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="19" cy="12" r="1.2" fill="currentColor" /></>,
  mail: <><rect x="2.5" y="4.5" width="19" height="15" rx="2" /><path d="m3 6.5 9 6.5 9-6.5" /></>,
  ban: <><circle cx="12" cy="12" r="9.5" /><path d="m5.3 5.3 13.4 13.4" /></>,
  restore: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>,
  panel: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></>,
  pencil: <><path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></>,
  sort: <><path d="M3 6h13M3 12h9M3 18h5M18 9V20m0 0-3-3m3 3 3-3" /></>,
  alert: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></>,
  userPlus: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></>,
};

export default function UserIcon({ name, size = 16, ...props }) {
  if (!local[name]) return <Icon name={name} size={size} {...props} />;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
    {local[name]}
  </svg>;
}
