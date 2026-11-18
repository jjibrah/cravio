// Small pieces shared by the Suppliers and Purchase orders screens (P2-13, P2-14).
import { useId, useMemo, useState } from 'react';
import { PO_STATUS, normalisePhone, showPhone } from '../../lib/inventory';
import { OIcon } from './parts';
import './purchasing.css';

export function StatusBadge({ status }) {
  const info = PO_STATUS[status] || { label: status, tone: 'off' };
  return <span className={`inv-badge is-${info.tone}`}>{info.label}</span>;
}

/** Finds an item by typing a few letters; picking one calls onPick(item). `hint(item)` adds a small note to each choice. */
export function ItemPicker({ items, onPick, label = 'Add an item', placeholder = 'Type to find an item', hint, exclude = [] }) {
  const id = useId();
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const term = text.trim().toLowerCase();
  const matches = useMemo(() => items.filter((item) => !exclude.includes(item.id) && (!term || `${item.name} ${item.sku || ''}`.toLowerCase().includes(term))).slice(0, 8), [items, term, exclude]);
  const pick = (item) => { onPick(item); setText(''); setFocus(false); };
  return <div className="pur-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false); }}>
    <label className="o-label" htmlFor={id}>{label}</label>
    <input id={id} className="o-input" type="search" autoComplete="off" placeholder={placeholder} value={text}
      onFocus={() => setFocus(true)} onChange={(event) => { setText(event.target.value); setFocus(true); }} />
    {focus && (term || matches.length > 0) && <ul className="pur-picks" aria-label="Matching items">
      {matches.length ? matches.map((item) => <li key={item.id}>
        <button type="button" onClick={() => pick(item)}><span>{item.name}</span>{hint?.(item) ? <small>{hint(item)}</small> : null}</button>
      </li>) : <li className="pur-picks-empty">No item matches “{text.trim()}”. Add it under Items first.</li>}
    </ul>}
  </div>;
}

/** A Kenyan phone box that accepts 0712…, +254712… or 254712… and shows how it will be saved. `value` is what is typed. */
export function PhoneField({ id, value, onChange, label = 'Phone', required = false }) {
  const typed = value.trim();
  const normal = typed ? normalisePhone(typed) : null;
  return <div className="o-field">
    <label className="o-label" htmlFor={id}>{label}{!required && <> <span className="o-optional">Optional</span></>}</label>
    <input id={id} className="o-input" type="tel" inputMode="tel" autoComplete="off" placeholder="0712 345 678" value={value} onChange={(event) => onChange(event.target.value)}
      aria-invalid={typed && !normal ? 'true' : undefined} aria-describedby={`${id}-hint`} />
    <p id={`${id}-hint`} className={typed && !normal ? 'o-field-error' : 'o-field-hint'} aria-live="polite">
      {!typed ? 'You can type it as 0712 345 678 or +254 712 345 678. Used for WhatsApp orders.'
        : normal ? <>Will be saved as <strong>{normal}</strong> ({showPhone(normal)}).</>
          : 'That doesn’t look like a Kenyan mobile number. Try 0712 345 678.'}
    </p>
  </div>;
}

/** An amount with its currency in front, so a price box is never just a number. */
export function MoneyBox({ id, label, value, onChange, placeholder = '0', suffix, ...rest }) {
  return <div className="pur-money">
    <label className="visually-hidden" htmlFor={id}>{label}</label>
    <span className="pur-money-prefix" aria-hidden="true">Ksh</span>
    <input id={id} className="o-input" type="number" inputMode="decimal" min="0" step="any" placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} {...rest} />
    {suffix && <span className="inv-unit-text">{suffix}</span>}
  </div>;
}

export function Note({ tone = 'info', children, ...rest }) {
  return <p className={`pur-note is-${tone}`} role={tone === 'ok' ? 'status' : undefined} {...rest}><OIcon name={tone === 'ok' ? 'check' : 'info'} size={15} /><span>{children}</span></p>;
}
