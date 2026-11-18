/*
 * Photos for evidence (invoices, goods, receipts). A phone camera makes 4-12 MB pictures; the server takes up to 8 MB and nobody
 * needs more than a readable page, so a photo is shrunk in the browser to at most 1600 px on its longest side and saved as JPEG
 * before it is sent. PDFs and anything that is not a picture go through untouched.
 */
export const MAX_SIDE = 1600;

function load(file) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture could not be opened.')); };
    image.src = url;
  });
}

/** Returns a File: the same one when it isn't a picture, otherwise a JPEG no bigger than `maxSide` pixels either way. */
export async function downscaleImage(file, { maxSide = MAX_SIDE, quality = 0.85 } = {}) {
  if (!file || file.prepared || !String(file.type || '').startsWith('image/')) return file;
  let source;
  try { source = await load(file); } catch { throw new Error('That picture could not be opened. Take it again, or choose another.'); }
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) return file;
  const name = `${String(file.name || 'photo').replace(/\.[a-z0-9]+$/i, '') || 'photo'}.jpg`;
  const out = new File([blob], name, { type: 'image/jpeg' });
  out.prepared = true; // already shrunk: uploading it again doesn't re-encode it
  return out;
}

/** A file's bytes as base64 (no data: prefix). */
export function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('That file could not be read. Try another one.'));
    reader.readAsDataURL(file);
  });
}
