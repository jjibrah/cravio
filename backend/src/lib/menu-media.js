// Dish video columns (migration 003). Until that migration is applied, menu queries keep working
// without them instead of failing, so the owner app and guest menu don't break in between.
import { HttpError } from './http.js';
import { mediaUrl } from './restaurants.js';

export const VIDEO_COLUMNS = 'video_url, video_poster_url, video_duration_seconds';
export const MAX_VIDEO_SECONDS = 15;

let installed = null; // true once seen; false is re-checked after a minute
let checkedAt = 0;

/** True when menu_items has the video columns. Cached. */
export async function hasVideoColumns(db) {
  if (installed === true) return true;
  if (installed === false && Date.now() - checkedAt < 60_000) return false;
  const { error } = await db.from('menu_items').select('video_url').limit(1);
  installed = !error;
  checkedAt = Date.now();
  if (error && error.code !== '42703' && error.code !== 'PGRST204') installed = null; // unrelated failure: decide next time
  return Boolean(installed);
}

/** `base` plus the video columns when they exist. */
export async function withVideoColumns(db, base) {
  return (await hasVideoColumns(db)) ? `${base}, ${VIDEO_COLUMNS}` : base;
}

/** camelCase video fields for an item row (nulls when the columns aren't there yet). */
export const videoOut = (row) => ({
  videoUrl: row.video_url ?? null,
  videoPosterUrl: row.video_poster_url ?? null,
  videoDurationSeconds: row.video_duration_seconds == null ? null : Number(row.video_duration_seconds),
});

const VIDEO_EXT = /\.(mp4|webm|mov)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;

/**
 * Validates video fields from a PATCH/POST body. Returns snake_case fields to write (possibly empty).
 * Clearing the video (videoUrl: null) also clears its poster and duration.
 * @param current the item's current row (for PATCH), so a duration already saved still counts
 */
export function videoFields(body, restaurantId, current = null) {
  const fields = {};
  const has = (key) => body[key] !== undefined;
  if (!has('videoUrl') && !has('videoPosterUrl') && !has('videoDurationSeconds')) return fields;

  if (has('videoUrl')) {
    const url = mediaUrl(body.videoUrl, restaurantId, 'the video', 'video');
    if (url && !VIDEO_EXT.test(new URL(url).pathname)) throw new HttpError(400, 'The video must be an MP4, WebM or MOV file.', { field: 'videoUrl' });
    fields.video_url = url;
    if (url === null) { fields.video_poster_url = null; fields.video_duration_seconds = null; return fields; }
  }
  if (has('videoPosterUrl')) {
    const url = mediaUrl(body.videoPosterUrl, restaurantId, 'the video poster', 'image');
    if (url && !IMAGE_EXT.test(new URL(url).pathname)) throw new HttpError(400, 'The video poster must be an image.', { field: 'videoPosterUrl' });
    fields.video_poster_url = url;
  }
  if (has('videoDurationSeconds')) {
    const value = body.videoDurationSeconds;
    if (value === null) fields.video_duration_seconds = null;
    else {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new HttpError(400, 'The video length must be a number of seconds.', { field: 'videoDurationSeconds' });
      if (value > MAX_VIDEO_SECONDS + 0.05) throw new HttpError(400, `Videos can be up to ${MAX_VIDEO_SECONDS} seconds. Trim it and try again.`, { field: 'videoDurationSeconds' });
      fields.video_duration_seconds = Math.min(MAX_VIDEO_SECONDS, Math.round(value * 10) / 10);
    }
  }
  const finalUrl = fields.video_url !== undefined ? fields.video_url : current?.video_url;
  const finalDuration = fields.video_duration_seconds !== undefined ? fields.video_duration_seconds : current?.video_duration_seconds;
  if (finalUrl && !finalDuration) throw new HttpError(400, `Send the video’s length in seconds (${MAX_VIDEO_SECONDS} or less).`, { field: 'videoDurationSeconds' });
  if (!finalUrl && (fields.video_poster_url || fields.video_duration_seconds)) {
    throw new HttpError(400, 'Add the video first, then its poster and length.', { field: 'videoUrl' });
  }
  return fields;
}
