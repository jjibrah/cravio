import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { guestMenuUrl } from '../../lib/onboarding';
import Brand, { BrandMark } from '../Brand';
import OnbIcon from './OnbIcon';

/** SVG markup for one table's QR code. */
async function qrSvg(url) {
  return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 0, color: { dark: '#111110', light: '#ffffff' } });
}

/** Print-ready pack: one card per table with the restaurant name and table number. */
export default function QrPack({ state }) {
  const { restaurant, tables } = state;
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all(tables.map(async (table) => ({ table, url: guestMenuUrl(restaurant.id, table.number), svg: await qrSvg(guestMenuUrl(restaurant.id, table.number)) })))
      .then((result) => { if (active) setCodes(result); })
      .catch(() => { if (active) setError('Couldn’t draw the QR codes. Reload the page to try again.'); });
    return () => { active = false; };
  }, [restaurant.id, tables]);
  useEffect(() => {
    const title = document.title;
    document.title = `${restaurant.name} · Table QR codes`;
    return () => { document.title = title; };
  }, [restaurant.name]);

  return <div className="qr-page">
    <header className="qr-toolbar">
      <Link className="onb-back" to="/onboarding/done" aria-label="Back"><OnbIcon name="back" size={20} /></Link>
      <div className="qr-toolbar-text"><h1>QR codes for {restaurant.name}</h1><p>{tables.length} table{tables.length === 1 ? '' : 's'} · Print on A4, cut along the lines, and place one on each table.</p></div>
      <button type="button" className="onb-primary" onClick={() => window.print()} disabled={!codes}><OnbIcon name="printer" size={18} />Print or save as PDF</button>
    </header>
    {error && <p className="onb-field-error" role="alert">{error}</p>}
    {!codes && !error && <p className="qr-loading" role="status">Drawing {tables.length} codes…</p>}
    {codes && <ol className="qr-grid" aria-label="Table QR codes">
      {codes.map(({ table, url, svg }) => <li key={table.number} className="qr-card">
        <span className="qr-card-name">{restaurant.name}</span>
        <span className="qr-code" role="img" aria-label={`QR code for table ${table.number}`} dangerouslySetInnerHTML={{ __html: svg }} />
        <span className="qr-card-table">Table {table.number}</span>
        <span className="qr-card-hint">Scan to see the menu</span>
        <span className="qr-card-url">{url.replace(/^https?:\/\//, '')}</span>
        <span className="qr-card-brand">Cravio<BrandMark /></span>
      </li>)}
    </ol>}
    <footer className="qr-footer"><Brand to="/owner" label="Cravio dashboard" /></footer>
  </div>;
}
