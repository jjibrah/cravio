import { Link } from 'react-router-dom';
import { checklistFor } from '../../lib/onboarding';
import OnbIcon from './OnbIcon';
import './checklist.css';

const STATUS_TEXT = { done: 'done', current: 'next up', upcoming: 'to do' };

/**
 * "Finish setting up" on the owner Overview: one clear next step with one button, and a calm pipeline of
 * everything else in the recommended order. When all is done it shrinks to a dismissible success note.
 */
export default function SetupChecklist({ state, onStartTour, onDismiss }) {
  const items = checklistFor(state);
  if (!items.length) return null;
  const total = items.length;
  const done = items.filter((item) => item.done).length;
  const next = items.find((item) => !item.done);

  if (!next) {
    if (state.progress?.data?.checklistDismissed) return null;
    return <section className="panel setup-card is-complete" id="finish-setup" aria-labelledby="finish-setup-title">
      <span className="setup-complete-badge" aria-hidden="true"><OnbIcon name="check" size={16} /></span>
      <div className="setup-complete-text">
        <h2 id="finish-setup-title">Setup complete</h2>
        <p>{state.restaurant.name} has everything guests and staff need. {total} of {total} done.</p>
      </div>
      <button type="button" className="setup-dismiss" onClick={onDismiss} aria-label="Dismiss setup complete">
        <OnbIcon name="close" size={16} /></button>
    </section>;
  }

  const open = (item, className, children, extra = {}) => (item.step
    ? <Link className={className} to={`/onboarding/${item.step}`} {...extra}>{children}</Link>
    : <button type="button" className={className} onClick={onStartTour} {...extra}>{children}</button>);

  return <section className="panel setup-card" id="finish-setup" aria-labelledby="finish-setup-title">
    <div className="setup-layout">
      <div className="setup-next">
        <p className="setup-eyebrow"><span id="finish-setup-title">Finish setting up</span><span aria-hidden="true"> · </span>{done} of {total} done</p>
        <h2 className="setup-title">{next.label}</h2>
        <p className="setup-why">{next.why}{next.hint && <span className="setup-hint"> {next.hint}</span>}</p>
        {open(next, 'setup-cta', <>{next.action}<OnbIcon name="arrow" size={18} /></>)}
      </div>

      <ol className="setup-pipeline" aria-label={`Setup steps, ${done} of ${total} done`}>
        {items.map((item, index) => {
          const status = item.done ? 'done' : item === next ? 'current' : 'upcoming';
          const linked = index > 0 && items[index - 1].done && status !== 'upcoming';
          const body = <>
            <span className="setup-node" aria-hidden="true">{item.done ? <OnbIcon name="check" size={12} strokeWidth={2.5} /> : index + 1}</span>
            <span className="setup-label">{item.short}<span className="visually-hidden">, {STATUS_TEXT[status]}</span></span>
          </>;
          return <li key={item.key} className={`setup-step is-${status}${linked ? ' is-linked' : ''}`} aria-current={status === 'current' ? 'step' : undefined}>
            {item.done ? <span className="setup-step-inner">{body}</span> : open(item, 'setup-step-inner', body, { tabIndex: status === 'current' ? -1 : undefined })}
          </li>;
        })}
      </ol>
    </div>
  </section>;
}
