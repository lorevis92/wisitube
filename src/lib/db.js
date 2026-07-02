// Local persistence for projects — IndexedDB via idb-keyval, so raw media Blobs
// (images, voiceover) survive a refresh or browser restart with no size limits.
import { get, set, del, entries, createStore } from 'idb-keyval';

const store = createStore('wisitube-db', 'projects');

export function createId() {
  return crypto.randomUUID();
}

export async function saveProject(project) {
  const toSave = { ...project, updatedAt: Date.now() };
  await set(toSave.id, toSave, store);
  return toSave;
}

export function loadProject(id) {
  return get(id, store);
}

export async function listProjects() {
  const all = await entries(store);
  return all.map(([, value]) => value).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function deleteProject(id) {
  return del(id, store);
}
