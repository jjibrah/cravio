import { useId, useState } from 'react';
import GuestSheet from '../menu/GuestSheet';
import { DealPhotos, Img } from '../menu/MenuCards';
import Glyph from '../media/Glyph';
import { formatKsh } from '../../lib/format';
import { KitchenNote, QtyStepper } from './DishSheet';

/** A deal up close: its photos, what's in it, the deal price against the regular price, and "Add to order". Key it by deal id. */
export default function DealSheet({ deal, itemsById, open, onClose, onAdd, contained }) {
  const titleId = useId();
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const footer = deal && <div className="gx-add-bar">
    <QtyStepper value={quantity} onChange={setQuantity} label={`How many ${deal.name}`} />
    <button type="button" className="gx-primary gx-add" onClick={() => onAdd({ deal, quantity, note: note.trim() })}>Add to order · {formatKsh(Number(deal.price) * quantity, deal.currency)}</button>
  </div>;

  return <GuestSheet open={open && Boolean(deal)} onClose={onClose} labelledBy={titleId} contained={contained} className="gx-dish-sheet gx-deal-sheet" footer={footer}>
    {deal && <article className="gx-dish">
      <div className="gx-deal-hero">
        <DealPhotos deal={deal} size="lg" />
        <button type="button" className="gx-media-close" onClick={onClose} aria-label="Close"><Glyph name="close" size={18} /></button>
      </div>
      <div className="gx-dish-head">
        <p className="gx-eyebrow">Deal</p>
        <h2 id={titleId} className="gx-dish-name">{deal.name}</h2>
        <p className="gx-deal-price">
          <strong>{formatKsh(deal.price, deal.currency)}</strong>
          {deal.saving > 0 && <><s aria-label={`Regular price ${formatKsh(deal.regularPrice, deal.currency)}`}>{formatKsh(deal.regularPrice, deal.currency)}</s><span className="mv-save">Save {formatKsh(deal.saving, deal.currency)}</span></>}
        </p>
        {deal.description && <p className="gx-dish-desc">{deal.description}</p>}
      </div>
      <section aria-labelledby={`${titleId}-in`}>
        <h3 id={`${titleId}-in`} className="gx-eyebrow">What’s in it</h3>
        <ul className="gx-parts">
          {(deal.items || []).map((part) => {
            const item = itemsById?.get(part.itemId);
            const photo = part.photoUrl || item?.photoUrl || item?.videoPosterUrl;
            return <li key={part.itemId}>
              {photo ? <Img className="gx-part-photo" src={photo} alt="" /> : <span className="gx-part-photo is-empty" aria-hidden="true">{[...part.name][0]}</span>}
              <span className="gx-part-name">{part.quantity > 1 && <strong>{part.quantity}× </strong>}{part.name}</span>
              <span className="gx-part-price">{formatKsh(Number(part.unitPrice) * part.quantity, deal.currency)}</span>
            </li>;
          })}
        </ul>
      </section>
      <KitchenNote value={note} onChange={setNote} open={noteOpen} onOpen={() => setNoteOpen(true)} />
    </article>}
  </GuestSheet>;
}
