import MenuView from '../menu/MenuView';
import { themeFor, themeStyle } from '../../lib/onboarding';

/**
 * The real guest menu (the shared MenuView) inside a device frame, over the merged onboarding state
 * (saved data plus unsaved drafts). Because it is the same component guests see, the two can't drift.
 * `focus` (the current step) is accepted for callers but the menu renders the same on every step.
 */
export default function PhonePreview({ restaurant, tables = [], categories = [], items = [], size = 'regular', label = 'Live preview of your guest menu' }) {
  const theme = themeFor(restaurant?.theme);
  return <figure className={`phone phone-${size}`} aria-label={label} style={themeStyle(theme)}>
    <div className="phone-screen" data-theme={theme.key}>
      <span className="phone-notch" aria-hidden="true" />
      <MenuView variant="preview" restaurant={restaurant || {}} categories={categories} items={items} tableNumber={tables.length ? 1 : undefined} />
    </div>
  </figure>;
}
