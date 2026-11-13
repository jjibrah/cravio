import { useMemo, useState } from 'react';
import { formatPrice } from '../../../lib/onboarding';
import { InlineError, useStep } from '../controls';
import ImageUpload from '../ImageUpload';
import OnbIcon from '../OnbIcon';

const dishCount = (done, total) => `${done} of ${total} ${total === 1 ? 'dish has a photo or video' : 'dishes have a photo or video'}`;
const videoBody = (fields) => (fields ? { videoUrl: fields.videoUrl, videoDurationSeconds: fields.videoDurationSeconds, ...(fields.videoPosterUrl ? { videoPosterUrl: fields.videoPosterUrl } : {}) } : { videoUrl: null });

/**
 * "Make it look delicious": the cover banner, then every dish laid out like the guest menu
 * (name, description and price on the left, a rounded-square photo on the right).
 * Each upload saves straight away, so the owner can leave at any point without losing anything.
 */
export function PhotosStep({ state, actions, live }) {
  const { restaurant, categories, items } = state;
  const [errors, setErrors] = useState({});
  // While a new photo is being saved, show it rather than flashing back to the old one.
  const [optimistic, setOptimistic] = useState({});

  const photoOf = (key, saved) => (key in optimistic ? optimistic[key] : saved) || null;
  const coverUrl = photoOf('cover', restaurant.coverUrl);
  const videoOf = (item) => (`video:${item.id}` in optimistic ? optimistic[`video:${item.id}`] : item);
  const withPhotos = items.filter((item) => photoOf(item.id, item.photoUrl) || videoOf(item)?.videoUrl).length;
  const allDishes = items.length > 0 && withPhotos === items.length;
  const complete = allDishes && Boolean(coverUrl);

  const groups = useMemo(() => {
    const list = categories.map((category) => ({ id: category.id, name: category.name, items: items.filter((item) => item.categoryId === category.id) }))
      .filter((group) => group.items.length);
    const known = new Set(categories.map((category) => category.id));
    const other = items.filter((item) => !known.has(item.categoryId));
    if (other.length) list.push({ id: 'other', name: 'Other', items: other });
    return list;
  }, [categories, items]);

  useStep({
    canContinue: live || withPhotos > 0 || Boolean(coverUrl),
    continueLabel: live ? 'Done' : undefined,
    skipLabel: 'Add photos later',
    hideSkip: live || complete,
  });

  const setError = (key, message) => setErrors((current) => ({ ...current, [key]: message }));
  async function save(key, url, request) {
    setError(key, '');
    setOptimistic((current) => ({ ...current, [key]: url }));
    try { await request(); }
    catch (error) { setError(key, error.message || 'Couldn’t save that photo. Try again.'); }
    finally { setOptimistic((current) => { const next = { ...current }; delete next[key]; return next; }); }
  }

  return <div className="onb-stack onb-photos">
    <section className="onb-photos-section" aria-labelledby="photos-cover-title">
      <div className="onb-photos-head">
        <h2 id="photos-cover-title">Cover photo</h2>
        <span className={`onb-photos-state${coverUrl ? ' is-done' : ''}`}>{coverUrl ? <><OnbIcon name="check" size={13} />Added</> : 'Top of your menu'}</span>
      </div>
      <div className="onb-photos-cover">
        <ImageUpload restaurantId={restaurant.id} kind="cover" variant="cover" value={coverUrl} label="Add a cover photo"
          hint="A wide shot of your space or a signature dish" onError={(message) => setError('cover', message)}
          onChange={(url) => save('cover', url, () => actions.patchRestaurant({ coverUrl: url }))} />
      </div>
      <InlineError>{errors.cover}</InlineError>
    </section>

    <section className="onb-photos-section" aria-labelledby="photos-dishes-title">
      <div className="onb-photos-head">
        <h2 id="photos-dishes-title">Dish photos</h2>
        {items.length > 0 && <span className={`onb-photos-state${allDishes ? ' is-done' : ''}`} role="status" aria-live="polite">
          {allDishes && <OnbIcon name="check" size={13} />}{dishCount(withPhotos, items.length)}</span>}
      </div>
      {items.length > 0 && <div className="onb-photos-meter" aria-hidden="true"><span style={{ width: `${(withPhotos / items.length) * 100}%` }} /></div>}
      {items.length > 0 && <p className="onb-media-hint">Each dish takes a photo (up to 5 MB) or a short video (up to 15 seconds, 25 MB). Videos play quietly on your menu.</p>}
      {allDishes && <p className="onb-cheer onb-photos-cheer">
        {complete ? 'Every dish has a photo and your cover is in. Looks delicious 😋' : 'Every dish has a photo 🎉 Add a cover to finish the look.'}</p>}

      {groups.map((group) => <div key={group.id} className="onb-photos-group">
        <h3>{group.name}</h3>
        <ul className="onb-photo-list" aria-label={`${group.name} dishes`}>
          {group.items.map((item) => <li key={item.id} className="onb-photo-row">
            <div className="onb-photo-text">
              <strong>{item.name}</strong>
              {item.description && <span className="onb-photo-desc">{item.description}</span>}
              <span className="onb-photo-price">{formatPrice(item.price, item.currency)}</span>
            </div>
            <ImageUpload restaurantId={restaurant.id} kind="items" variant="dish" value={photoOf(item.id, item.photoUrl)} label={`a photo or video of ${item.name}`}
              onError={(message) => setError(item.id, message)}
              onChange={(url) => save(item.id, url, () => actions.updateItem(item.id, { photoUrl: url }))}
              video={videoOf(item)} onVideoChange={(fields) => save(`video:${item.id}`, fields || { videoUrl: null }, () => actions.updateItem(item.id, videoBody(fields)))} />
            {(errors[item.id] || errors[`video:${item.id}`]) && <p className="onb-field-error onb-photo-error" role="alert"><OnbIcon name="alert" size={14} />{errors[item.id] || errors[`video:${item.id}`]}</p>}
          </li>)}
        </ul>
      </div>)}

      {!items.length && <p className="onb-note">Your dishes show up here once you’ve added them.{' '}
        <button type="button" className="onb-text-button" onClick={() => actions.goTo('items')}>Add dishes</button></p>}
    </section>
  </div>;
}
