import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { THEMES, themeStyle } from '../../../lib/onboarding';
import { useStep } from '../controls';
import OnbIcon from '../OnbIcon';
import PhonePreview from '../PhonePreview';

export function ThemeStep({ state, actions, setDraft }) {
  const [theme, setTheme] = useState(state.restaurant.theme || 'classic');
  useEffect(() => { setDraft({ theme }); }, [theme, setDraft]);
  useStep({ canContinue: true, onContinue: () => (theme === state.restaurant.theme ? undefined : actions.patchRestaurant({ theme })) });
  return <div className="onb-themes" role="radiogroup" aria-label="Menu look">
    {THEMES.map((option) => <button type="button" role="radio" aria-checked={theme === option.key} key={option.key}
      className={`onb-theme${theme === option.key ? ' is-selected' : ''}`} onClick={() => setTheme(option.key)} style={themeStyle(option)}>
      <span className="onb-theme-sample" aria-hidden="true">
        <span className="onb-theme-aa">Aa</span>
        <span className="onb-theme-lines"><span /><span /></span>
        <span className="onb-theme-dot" />
      </span>
      <span className="onb-theme-text"><strong>{option.label}</strong><span>{option.hint}</span></span>
      <span className="onb-option-check" aria-hidden="true"><OnbIcon name="check" size={14} /></span>
    </button>)}
  </div>;
}

export function PreviewStep({ preview, missing, live }) {
  useStep({ canContinue: true, continueLabel: live ? 'Save' : 'Go live' });
  return <div className="onb-final">
    <PhonePreview {...preview} size="large" focus="preview" label="Your guest menu, as guests will see it" />
    {missing?.length > 0 && <div className="onb-missing" role="alert">
      <strong>A few things before you go live</strong>
      <ul>{missing.map((entry) => <li key={entry.step}><Link to={`/onboarding/${entry.step}`}>{entry.message}<OnbIcon name="arrow" size={14} /></Link></li>)}</ul>
    </div>}
  </div>;
}
