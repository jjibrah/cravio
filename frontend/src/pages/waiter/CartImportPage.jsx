import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import Glyph from '../../components/media/Glyph';
import OrderComposer from '../../components/waiter/OrderComposer';
import { PageHeader, TablePicker } from '../../components/waiter/WaiterBits';
import { cleanCode } from '../../components/waiter/CodeScanner';

const grouped = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;

/**
 * The guest's order, opened by scanning their QR (the phone camera opens this link; the in-app scanner adds
 * ?via=scan) or by typing their code (?via=typed). Loads it, then "Check with the guest" and Confirm order.
 */
export default function CartImportPage() {
  const { code: raw } = useParams();
  const [params, setParams] = useSearchParams();
  const code = cleanCode(raw);
  const [state, setState] = useState({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const tableOverride = /^\d{1,3}$/.test(params.get('table') || '') ? Number(params.get('table')) : undefined;
  // Opening the QR link is a scan; the "Type code" paths say so.
  const via = params.get('via') === 'typed' ? 'typed' : 'scan';
  const keep = (extra) => ({ ...(params.get('via') ? { via: params.get('via') } : {}), ...extra });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    if (code.length !== 6) { setState({ status: 'invalid' }); return undefined; }
    api(`/api/ops/carts/${code}`)
      .then(({ cart }) => { if (live) setState({ status: 'ready', cart }); })
      .catch((error) => { if (live) setState({ status: 'error', error }); });
    return () => { live = false; };
  }, [code, attempt]);

  if (state.status === 'loading') {
    return <>
      <PageHeader title="Guest’s order" subtitle={code ? `Code ${grouped(code)}` : undefined} />
      <div className="w-stack" aria-busy="true" aria-label="Loading the guest’s order">{[0, 1, 2].map((i) => <span key={i} className="w-row-skeleton" />)}</div>
    </>;
  }

  if (state.status !== 'ready') {
    const error = state.error;
    const look = state.status === 'invalid' ? { title: 'That code doesn’t look right', text: 'Cart codes are 6 letters and numbers, like ACD 347. Ask the guest to show it again.' }
      : error.status === 410 ? { title: 'This code has expired', text: 'Guest codes last 2 hours. Ask the guest to tap “Ready to order” again for a fresh one.' }
        : error.status === 409 ? { title: 'Already confirmed', text: `${error.message} Nothing else to do here.` }
          : error.status === 404 ? { title: 'We couldn’t find that order', text: error.message }
            : { title: 'Couldn’t load the order', text: error.message };
    return <>
      <PageHeader title="Guest’s order" subtitle={code ? `Code ${grouped(code)}` : undefined} />
      <div className="w-empty">
        <span className="w-empty-icon is-warn"><Glyph name="alert" size={26} /></span>
        <h2>{look.title}</h2>
        <p>{look.text}</p>
        <div className="w-stack">
          {error && error.status !== 409 && error.status !== 410 && error.status !== 404 && <button type="button" className="w-btn w-btn-secondary w-btn-big" onClick={() => setAttempt((n) => n + 1)}>Try again</button>}
          <Link className="w-btn w-btn-primary w-btn-big" to="/waiter/order/new">Scan or type another code</Link>
          <Link className="w-btn w-btn-quiet w-btn-big" to="/waiter/services">Back to Services</Link>
        </div>
      </div>
    </>;
  }

  if (!state.cart.table && tableOverride === undefined && params.get('table') !== 'takeaway') {
    return <>
      <PageHeader title="Guest’s order" subtitle={`Code ${grouped(state.cart.code)} · which table is it for?`} />
      <TablePicker onChoose={(value) => setParams(keep({ table: String(value) }))} />
    </>;
  }

  return <>
    <PageHeader title="Guest’s order" subtitle={`Code ${grouped(state.cart.code)} · ${via === 'scan' ? 'scanned' : 'typed'}`} />
    <OrderComposer key={state.cart.code} initialCart={state.cart} initialVia={via} allowImport={false} table={params.get('table') === 'takeaway' ? 'takeaway' : tableOverride ?? state.cart.table?.number ?? undefined}
      onChangeTable={state.cart.table ? undefined : () => setParams(keep({}))} />
  </>;
}
