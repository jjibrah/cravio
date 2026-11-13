// One stroke family (24px grid, 1.75 stroke, round joins), drawn after Lucide.
const paths = {
  overview: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  restaurants: <><path d="M3 10h18l-2-6H5l-2 6Zm1 0v10h16V10M9 20v-6h6v6" /></>,
  performance: <><path d="M3 3v18h18M7 15l4-4 3 3 6-6" /></>,
  money: <><rect x="2" y="6" width="20" height="13" rx="2" /><circle cx="12" cy="12.5" r="2.5" /><path d="M6 12.5h.01M18 12.5h.01" /></>,
  leads: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" /></>,
  complaints: <><path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12Z" /><path d="M12 8v4m0 3.5h.01" /></>,
  orders: <><path d="M5 2v20l2.5-1.5L10 22l2-1.5 2 1.5 2.5-1.5L19 22V2l-2.5 1.5L14 2l-2 1.5L10 2 7.5 3.5Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  tables: <><path d="M3 9h18M5 9v11M19 9v11M3 9l2-4h14l2 4M8 14h8" /></>,
  menu: <><path d="M2 4.5c3-1.3 6.5-1.3 10 1 3.5-2.3 7-2.3 10-1V20c-3-1.3-6.5-1.3-10 1-3.5-2.3-7-2.3-10-1Z" /><path d="M12 5.5V21" /></>,
  products: <><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4Z" /><circle cx="7.5" cy="7.5" r="1.5" /></>,
  insights: <><path d="M3 21h18M7 17v-6m5 6V6m5 11v-4" /></>,
  settings: <><path d="M20 7h-9M14 17H4" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></>,
  contact: <><circle cx="12" cy="12" r="9.5" /><path d="M9.2 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" /></>,
  qr: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM21 14v.01M14 21h.01M17.5 21H21v-3.5" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></>,
  external: <><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  chevrons: <><path d="m7 15 5 5 5-5M7 9l5-5 5 5" /></>,
  chevron: <><path d="m9 6 6 6-6 6" /></>,
  bars: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
  close: <><path d="m6 6 12 12M6 18 18 6" /></>,
  success: <><circle cx="12" cy="12" r="9.5" /><path d="m8 12 3 3 5-6" /></>,
  info: <><circle cx="12" cy="12" r="9.5" /><path d="M12 11v6m0-9.5h.01" /></>,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
  services: <><path d="M3 17h18M5 17a7 7 0 0 1 14 0M12 10V7m-2 0h4M3 21h18" /></>,
  refresh: <><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16m5 0H3v5" /></>,
  check: <><path d="M20 6 9 17l-5-5" /></>,
  lock: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
  team: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>,
  devices: <><rect x="2" y="4" width="13" height="10" rx="1.5" /><path d="M5.5 18h6M8.5 14v4" /><rect x="17" y="8" width="5" height="12" rx="1.2" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  layers: <><path d="m12 2 10 5-10 5L2 7Z" /><path d="m2 17 10 5 10-5M2 12l10 5 10-5" /></>,
  leaf: <><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z" /><path d="M2 21c0-3 1.9-5.4 5.1-6" /></>,
  utensils: <><path d="M3 2v7a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6a2 2 0 0 0 2 2Zm0 0v7" /></>,
  dessert: <><path d="m7 11 4.1 10.4a1 1 0 0 0 1.8 0L17 11M17 7A5 5 0 0 0 7 7" /><path d="M17 7a2 2 0 0 1 0 4H7a2 2 0 0 1 0-4" /></>,
  drink: <><path d="M8 22h8M7 10h10M12 15v7M12 15a5 5 0 0 0 5-5c0-2-.5-4-2-8H9c-1.5 4-2 6-2 8a5 5 0 0 0 5 5Z" /></>,
  percent: <><path d="M19 5 5 19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></>,
  internal: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" /></>,
};

export default function Icon({ name, size = 20, ...props }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
    {paths[name] || paths.overview}
  </svg>;
}
