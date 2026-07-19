// Shared Supabase project across the Wisi apps — auth only for now (see AuthScreen.jsx for the
// app-metadata tag that keeps signups here from polluting other apps' profiles). The data layer
// (IndexedDB, src/lib/db.js) is untouched until the multi-user migration's next phase.
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);
