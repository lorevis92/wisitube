// Phase 3 of the multi-user migration: real persistence for the media Blobs that Phase 2's
// stripBlobsForSync (src/lib/db.js) strips out of the jsonb project/settings columns before every
// save — scene images, scene audio, thumbnails and reference photos now get a durable backup in
// Supabase Storage (bucket 'wisitube-media', private, per-user-folder RLS), while the Blob itself
// stays in memory/IndexedDB for the current session for immediate use (canvas draws, audio decode,
// video export) exactly as before.
import { supabase } from './supabase';

const BUCKET = 'wisitube-media';
const SIGNED_URL_TTL_SECONDS = 3600;

// blob.type is usually "image/png", "audio/mpeg", sometimes with a ";codecs=…" suffix on audio —
// strip that, and fix the one common mismatch (jpeg -> jpg) so paths stay tidy.
function extensionForBlob(blob) {
  const subtype = (blob.type || '').split('/')[1] || 'bin';
  const clean = subtype.split(';')[0].trim();
  return clean === 'jpeg' ? 'jpg' : clean || 'bin';
}

// kind: 'scene-image' | 'scene-audio' | 'thumbnail' | 'reference'
// Returns the storage path (not a public URL — the bucket is private, use getMediaUrl/
// downloadMediaAsBlob to read it back).
export async function uploadMedia(userId, videoId, kind, id, blob) {
  // supabase.auth.getSession() awaits the client's own internal session hydration/refresh before
  // resolving — calling it right before the Storage request (rather than trusting the client's
  // ambient in-memory state) closes off any race where the JWT the request would otherwise send
  // hasn't finished loading/refreshing yet. Without it, the request goes out effectively
  // unauthenticated and RLS on storage.objects rejects the insert ("new row violates row-level
  // security policy") even though the path itself is built from the correct userId.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('No authenticated Supabase session — cannot upload to Storage (the request would be rejected by RLS as anonymous).');
  }

  const path = `${userId}/${videoId}/${kind}/${id}.${extensionForBlob(blob)}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: blob.type });
  if (error) throw error;
  return path;
}

// Short-lived signed URL for previewing/using a file right now — never persist this URL itself,
// it expires; call this again whenever the file needs to be shown/used.
export async function getMediaUrl(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}

// For callers that need the actual bytes (video export, canvas draws) rather than just a URL to
// point an <img>/<audio> at.
export async function downloadMediaAsBlob(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw error;
  return data;
}
