// One-time cleanup of ORPHANED folders in the `wisitube-media` Supabase Storage bucket.
//
// Why: before the delete-cascade fix (commit 5cb18aa) and the "don't delete the row without its
// media" fixes, deleting a video removed its wisitube_videos row but left every
// {userId}/{videoId}/... file behind in Storage. Nothing references those files any more; they are
// pure dead weight and are pushing the project over its Storage quota. This removes them.
//
// HOW IT DECIDES WHAT IS AN ORPHAN (read this before running --delete):
//   valid folder ids =
//        every `id` in wisitube_videos
//      ∪ `channel-defaults-<id>` for every `id` in wisitube_channels
//        (a channel's default background image is stored under a per-channel PSEUDO videoId —
//         see src/steps/ChannelDashboardStep.jsx: channelDefaultsPseudoVideoId)
//
//   For each real folder {userId}/{folderId}/... in the bucket:
//     - folderId IS in `valid`                        -> KEEP (a live video / channel). Never touched.
//     - folderId is a UUID and NOT in `valid`         -> ORPHAN (a deleted video).
//     - folderId is `channel-defaults-<UUID>` not in `valid` -> ORPHAN (a deleted channel's default).
//     - folderId is any other shape                   -> LEFT ALONE, only reported (investigate).
//
// SAFETY:
//   - Dry-run by default. Nothing is deleted without --delete, and only after you have seen the
//     dry-run numbers.
//   - Aborts if the DB returns 0 videos (a failed/blocked query must never make the whole bucket
//     look orphaned) — override with --force only if the project genuinely has no videos.
//   - The DB reads are paginated; the printed video/channel counts should match your dashboard.
//
// AUTH — provide, via env vars OR --env-file=<path> (a dotenv file, e.g. from `vercel env pull`):
//   (VITE_)SUPABASE_URL + SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY
//       (service-role key from Supabase project settings → API. Bypasses RLS, sees every user.)
//   (VITE_)SUPABASE_URL + (VITE_)SUPABASE_ANON_KEY + SUPABASE_EMAIL + SUPABASE_PASSWORD
//       (signs in as that user; everything is then RLS-scoped to that one user — fine for a
//        single-user project.)
//   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are accepted so a raw `vercel env pull` file works.
//
// RUN:
//   node scripts/cleanup-orphan-storage.mjs --env-file=.env.local            # dry run
//   node scripts/cleanup-orphan-storage.mjs --env-file=.env.local --delete   # actually delete
//   node scripts/cleanup-orphan-storage.mjs --delete --force                 # even if DB shows 0 videos

import { createClient } from '@supabase/supabase-js';

const BUCKET = 'wisitube-media';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');
const CHANNEL_DEFAULTS_RE = new RegExp(`^channel-defaults-${UUID}$`, 'i');

const args = new Set(process.argv.slice(2));
const DO_DELETE = args.has('--delete');
const FORCE = args.has('--force');

// Also accept the VITE_-prefixed names, so a plain `vercel env pull` file (or the app's own .env)
// works with no renaming. An --env-file=<path> arg loads a dotenv file first.
const envFileArg = process.argv.find((a) => a.startsWith('--env-file='));
if (envFileArg) {
  const fs = await import('node:fs');
  for (const line of fs.readFileSync(envFileArg.slice('--env-file='.length), 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const EMAIL = process.env.SUPABASE_EMAIL;
const PASSWORD = process.env.SUPABASE_PASSWORD;

if (!SUPABASE_URL || (!SERVICE_KEY && !ANON_KEY)) {
  console.error('Missing env. Need SUPABASE_URL and either SUPABASE_SERVICE_KEY, or SUPABASE_ANON_KEY + SUPABASE_EMAIL + SUPABASE_PASSWORD.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY || ANON_KEY, { auth: { persistSession: false } });

const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  if (SERVICE_KEY) {
    console.log('Auth: service-role key (all users visible).');
  } else {
    if (!EMAIL || !PASSWORD) {
      console.error('With SUPABASE_ANON_KEY you must also set SUPABASE_EMAIL and SUPABASE_PASSWORD.');
      process.exit(1);
    }
    const { error } = await supabase.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    if (error) {
      console.error('Sign-in failed:', error.message);
      process.exit(1);
    }
    console.log(`Auth: signed in as ${EMAIL} (RLS-scoped to this user).`);
  }

  // ---- 1. valid folder ids ----
  const videoIds = await fetchAllIds('wisitube_videos');
  const channelIds = await fetchAllIds('wisitube_channels');
  console.log(`DB: ${videoIds.length} video(s), ${channelIds.length} channel(s).`);
  if (videoIds.length === 0 && !FORCE) {
    console.error('\nABORT: the DB returned 0 videos. That is almost certainly a failed/blocked query, not reality.');
    console.error('If the project genuinely has no videos, re-run with --force.');
    process.exit(1);
  }

  const valid = new Set(videoIds);
  for (const c of channelIds) valid.add(`channel-defaults-${c}`);

  // ---- 2. walk the bucket ----
  const userFolders = await listChildFolders('');
  console.log(`Storage: ${userFolders.length} top-level (user) folder(s): ${userFolders.join(', ') || '(none)'}`);

  const orphans = []; // { key, files: [{path,size}], bytes }
  const unknown = []; // { key, bytes, files }
  let keptCount = 0;
  let keptBytes = 0;

  for (const userId of userFolders) {
    const idFolders = await listChildFolders(userId);
    for (const folderId of idFolders) {
      const key = `${userId}/${folderId}`;
      const files = await listAllFiles(key);
      const bytes = files.reduce((a, f) => a + f.size, 0);

      if (valid.has(folderId)) {
        keptCount += 1;
        keptBytes += bytes;
        continue;
      }
      if (UUID_RE.test(folderId) || CHANNEL_DEFAULTS_RE.test(folderId)) {
        orphans.push({ key, files, bytes });
      } else {
        unknown.push({ key, files, bytes });
      }
    }
  }

  orphans.sort((a, b) => b.bytes - a.bytes);

  // ---- 3. report ----
  console.log('\n================  ORPHANED FOLDERS  ================');
  let totalBytes = 0;
  let totalFiles = 0;
  for (const o of orphans) {
    totalBytes += o.bytes;
    totalFiles += o.files.length;
    console.log(`  ${o.key}   ${o.files.length} file(s)   ${mb(o.bytes)}`);
    for (const f of o.files.slice(0, 3)) console.log(`      ${f.path}  (${mb(f.size)})`);
    if (o.files.length > 3) console.log(`      … +${o.files.length - 3} more`);
  }
  console.log('\n--------------------------------------------------');
  console.log(`  Orphan folders : ${orphans.length}`);
  console.log(`  Orphan files   : ${totalFiles}`);
  console.log(`  Space to free  : ${mb(totalBytes)}  (${totalBytes} bytes)`);
  console.log(`  Kept (live)    : ${keptCount} folder(s), ${mb(keptBytes)}`);
  if (unknown.length) {
    console.log(`\n  ${unknown.length} folder(s) with an UNEXPECTED id shape — NOT an orphan candidate, left untouched, listed for review:`);
    for (const u of unknown) console.log(`      ${u.key}   ${u.files.length} file(s)   ${mb(u.bytes)}`);
  }
  console.log('--------------------------------------------------');

  // ---- 4. delete ----
  if (!DO_DELETE) {
    console.log('\nDRY RUN — nothing was deleted. Re-run with --delete to remove the orphan folders listed above.');
    return;
  }
  if (orphans.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  console.log(`\n--delete set. Removing ${totalFiles} file(s) across ${orphans.length} folder(s)…`);
  let freed = 0;
  let removed = 0;
  let failed = 0;
  for (const o of orphans) {
    const paths = o.files.map((f) => f.path);
    let folderFailed = false;
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      // eslint-disable-next-line no-await-in-loop
      const { error } = await supabase.storage.from(BUCKET).remove(batch);
      if (error) {
        console.error(`  FAILED ${o.key}: ${error.message}`);
        folderFailed = true;
        failed += batch.length;
        break;
      }
      removed += batch.length;
    }
    if (!folderFailed) {
      freed += o.bytes;
      console.log(`  removed ${o.key}  (${paths.length} files, ${mb(o.bytes)})`);
    }
  }
  console.log(`\nDone. Removed ${removed} file(s), freed ~${mb(freed)}.${failed ? `  ${failed} file(s) failed — re-run to retry.` : ''}`);
}

async function fetchAllIds(table) {
  const ids = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.from(table).select('id').range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} query failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) if (r?.id) ids.push(r.id);
    if (data.length < PAGE) break;
  }
  return ids;
}

// Names of the immediate sub-FOLDERS of `prefix` (Storage list() marks folders with id === null).
async function listChildFolders(prefix) {
  const names = [];
  for (let offset = 0; ; offset += 100) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 100, offset });
    if (error) throw new Error(`list('${prefix}') failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const e of data) if (e.id === null && e.name) names.push(e.name);
    if (data.length < 100) break;
  }
  return names;
}

// Every file (recursively) under `prefix`, with byte sizes. Our layout is
// {userId}/{videoId}/{kind}/{file} but this walks any depth defensively.
async function listAllFiles(prefix) {
  const out = [];
  const stack = [prefix];
  while (stack.length) {
    const cur = stack.pop();
    for (let offset = 0; ; offset += 100) {
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await supabase.storage.from(BUCKET).list(cur, { limit: 100, offset });
      if (error) throw new Error(`list('${cur}') failed: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const e of data) {
        if (!e.name) continue;
        if (e.id === null) stack.push(`${cur}/${e.name}`); // sub-folder
        else out.push({ path: `${cur}/${e.name}`, size: Number(e.metadata?.size) || 0 });
      }
      if (data.length < 100) break;
    }
  }
  return out;
}

main().catch((e) => {
  console.error('\nUNEXPECTED ERROR — nothing further was deleted:', e?.message || e);
  process.exit(1);
});
