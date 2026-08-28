import React, { useEffect, useRef, useState } from 'react';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import ChannelsListStep from './steps/ChannelsListStep';
import ChannelDashboardStep from './steps/ChannelDashboardStep';
import CreateStep from './steps/CreateStep';
import TitleSelectStep from './steps/TitleSelectStep';
import StoryboardStep from './steps/StoryboardStep';
import EditorStep from './steps/EditorStep';
import ExportStep from './steps/ExportStep';
import AutomationStep from './steps/AutomationStep';
import AutomationMirrorStep, { INCOMPLETE_POLL_MS } from './steps/AutomationMirrorStep';
import FullScreenLoader from './components/FullScreenLoader';
import AuthScreen from './components/AuthScreen';
import { T, FONT, mono, card, btnGhost } from './theme';
import { createId, saveVideo, saveYoutubeConnection, getSchedulerSettings, loadChannel, listIncompleteVideos } from './lib/db';
import { startScheduler, stopSchedulerTimer, applyProgressToRun } from './lib/automationScheduler';
import { STYLES } from './lib/pollinations';
import { generateAllScenes } from './lib/sceneOrchestrator';
import { supabase } from './lib/supabase';
import { resumePendingBatches } from './lib/batchResumption';
import { rehydrateProjectMedia } from './lib/mediaRehydration';
import { uploadMedia } from './lib/mediaStorage';

let sceneIdCounter = 1;
let beatIdCounter = 1;

// Array.isArray/length guard: projects saved before the 2-image-beat model lack `images`
// entirely — treat those as not-ready rather than crashing on scenes.every() over undefined.
// content_type 'static_background' scenes ALSO lack `images` entirely, but for the opposite
// reason (intentional — there is no per-scene image for this content type at all, see
// buildScenesFromRaw above) — isStaticBackground disambiguates "images N/A, ignore" from
// "images missing/legacy, not ready".
const isSceneMediaReady = (s, isStaticBackground = false) =>
  (isStaticBackground || (Array.isArray(s.images) && s.images.length > 0 && s.images.every((im) => im.status === 'ready'))) &&
  s.audioStatus === 'ready';

// Turns the raw { narration, image_beats } scenes returned by api/generate-scenes.js into the
// internal scene/beat shape the rest of the app works with — shared by the incremental partial
// save (during chunked generation) and the final assembly, so both stay in sync.
//
// isStaticBackground: content_type 'static_background' scenes have no image_beats in the API
// response at all (see api/generate-scenes.js) — the `images` field is omitted entirely rather
// than filled with placeholder beats, so every consumer (StoryboardStep.jsx, mediaGenerationEngine.js,
// videoRenderEngine.js, etc.) can tell "no images for this content type" apart from "images not
// generated yet" just by the field's absence, instead of quietly treating two empty placeholder
// beats as real, billable, renderable image slots (the root cause of the phantom-cost/image bug).
function buildScenesFromRaw(rawScenes, isStaticBackground) {
  return (rawScenes || []).map((s) => {
    const base = {
      id: sceneIdCounter++,
      narration: s.narration || '',
      pad: 0.3,
      audioStatus: 'idle',
      audioUrl: '',
      audioBlob: null,
      audioDuration: 0,
    };
    if (isStaticBackground) return base;

    const beats = Array.isArray(s.image_beats) && s.image_beats.length ? s.image_beats.slice(0, 2) : [{}, {}];
    while (beats.length < 2) beats.push({});
    return {
      ...base,
      images: beats.map((b) => ({
        id: beatIdCounter++,
        prompt: b.image_prompt || '',
        animation: b.animation || 'zoom_in',
        referenceId: b.reference_id || null,
        characterId: b.character_id || null,
        variantLabel: b.variant_label || null,
        seed: Math.floor(Math.random() * 999999),
        status: 'idle',
        url: '',
        blob: null,
      })),
    };
  });
}

export default function App() {
  // undefined = getSession() hasn't resolved yet, null = resolved and no session, object = signed
  // in. The distinct "still checking" state stops a signed-in user from flashing AuthScreen while
  // Supabase reads the session out of local storage.
  const [session, setSession] = useState(undefined);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 760);
  const [tab, setTab] = useState('channels');
  // Lightweight, App-level mirror of whatever the automation engine is doing right now — set by
  // AutomationStep.jsx (see its onRunUpdate prop below) from runAutomationCycle/runFullPipeline's
  // onProgress events, independent of which tab/screen the user actually has open. null whenever no
  // real (non-dry-run) automation cycle is currently running. Shape: { channelId, channelName,
  // videoId, phase, phaseDetail, project, log }.
  const [currentAutomationRun, setCurrentAutomationRun] = useState(null);
  // Count of videos across every channel that are genuinely just sitting there — waitingReason
  // 'idle' from src/lib/db.js's listIncompleteVideos, NOT 'awaiting_batch' (those are legitimately
  // waiting on Google, not stuck) — drives Navbar.jsx's notification-style badge on the automation
  // status button. Polled at the same INCOMPLETE_POLL_MS cadence AutomationMirrorStep.jsx's own
  // "Videos in progress" list already uses, so the badge and that list can never disagree about
  // what "right now" means.
  const [idleVideoCount, setIdleVideoCount] = useState(0);
  // Whether the unattended background scheduler (src/lib/automationScheduler.js) should be
  // ticking right now — read once from Supabase on mount/sign-in, then kept in sync by
  // AutomationStep.jsx's "Automatic scheduling" panel via onSchedulerEnabledChange below every time
  // the user toggles it. The actual setInterval lives in automationScheduler.js, started/stopped by
  // the effect below whenever this changes — deliberately App-level (not inside AutomationStep.jsx
  // itself) so the heartbeat keeps ticking while the user is on any other tab, not just Automation.
  const [schedulerEnabled, setSchedulerEnabled] = useState(false);
  const [currentChannelId, setCurrentChannelId] = useState(null);
  const [currentChannelName, setCurrentChannelName] = useState('');
  // Single source of truth for the currently open channel's full record (including youtube.*) —
  // ChannelDashboardStep is the one component that actually loads/mutates it (via onChannelChange
  // below) since it's guaranteed to mount before any other step that needs channel data is
  // reachable; everyone else (ExportStep) just reads this prop instead of doing its own
  // independent IndexedDB fetch, which is what let those fetches drift out of sync with each other.
  const [currentChannel, setCurrentChannel] = useState(null);
  const [settings, setSettings] = useState({
    topic: '',
    style: 'facestick',
    voice: 'af_heart',
    voiceEngine: 'kokoro',
    speechSpeed: 1.0,
    imageProvider: 'pollinations',
    // 'full_pipeline' (default, image-driven) vs. 'static_background' (spoken narration only, one
    // unchanging background — see CreateStep.jsx's "Content type" select).
    contentType: 'full_pipeline',
    lengthMinutes: 5,
    // When true, lengthMinutes is ignored — api/generate-outline.js lets Claude size the video off
    // how much content the topic genuinely supports instead of a fixed target (see CreateStep.jsx's
    // "Let AI decide the ideal length" toggle). No safety cap in the manual flow — the user already
    // sees a cost/time estimate before committing to generation, so there's no unattended-spend risk
    // that a cap would need to guard against (unlike automation's per-channel version of this).
    aiDecidesLength: false,
    format: '16:9',
    language: 'English',
    references: [],
    characterHints: [],
    generalNotes: '',
    // Set only when a video is started from a Content Program Manager suggestion that belongs to
    // a series — carried through the whole titles/outline/scenes pipeline into project.series so
    // ExportStep can default "Add to series playlist" without the user re-typing it.
    series: null,
  });
  const [project, setProject] = useState(null);
  const [projectId, setProjectId] = useState(null);
  const [createdAt, setCreatedAt] = useState(null);
  // The channel the OPEN video actually belongs to — distinct from currentChannelId (which just
  // means "which channel dashboard is on screen right now"). Set exactly once, at the moment a
  // video is created (handleOutlineReady) or resumed (handleResume), and never touched by mere
  // channel-dashboard navigation. Before this existed, the autosave effect and persistPartial both
  // read currentChannelId directly — so leaving a video open (project/projectId not reset) and
  // then browsing to a different channel via the "Channels" breadcrumb silently reassigned that
  // video to whatever channel was on screen when the debounced save next fired. null whenever no
  // video is known to be safely attributable to a channel — the autosave guard below refuses to
  // save in that state rather than writing a wrong or null channel_id.
  const [openVideoChannelId, setOpenVideoChannelId] = useState(null);
  // True while handleResume is re-downloading scene/audio/reference Blobs from Supabase Storage
  // for a video whose media survives only there (Phase 3) — the rest of the app assumes
  // project.scenes already has usable Blob/object-URLs, so nothing renders until that's true.
  const [resuming, setResuming] = useState(false);

  // Titles → outline → chunked-scenes pipeline state. Transient — only meaningful while tab is
  // 'titles' or 'generating-scenes'. Once scene generation finishes, everything converges into
  // `project`, exactly like the old single-call flow.
  const [titleOptions, setTitleOptions] = useState(null);
  const [pendingPlan, setPendingPlan] = useState(null);
  const [sceneProgress, setSceneProgress] = useState({ current: 0, total: 0 });
  const [generationError, setGenerationError] = useState('');

  // Bumped every time the open video is switched (new/resume/reset) so a debounced save
  // scheduled for the *previous* video can detect it's stale and refuse to write, even if the
  // effect-cleanup cancellation below ever fails to fire in time. Also used to abandon a
  // titles/outline/scenes pipeline run that's no longer relevant (a newer one started, or the
  // user reset) so its eventual completion doesn't silently stomp whatever came after it.
  const generationRef = useRef(0);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 760);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Auth gate — Phase 1 of the multi-user migration. Only gates access to the app; the data layer
  // (IndexedDB, src/lib/db.js) isn't scoped to the user yet, that's Phase 2.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Read the scheduler's enabled flag once a session exists — AutomationStep.jsx's panel is the
  // only thing that changes it afterward (via onSchedulerEnabledChange below), so this never needs
  // to re-poll on its own.
  useEffect(() => {
    if (!session?.user?.id) return;
    getSchedulerSettings()
      .then((s) => setSchedulerEnabled(!!s.enabled))
      .catch((err) => console.error('[App] failed to load scheduler settings', err));
  }, [session?.user?.id]);

  // Starts/stops the scheduler's 60s heartbeat whenever enabled changes (or a session appears) —
  // onProgress feeds the exact same currentAutomationRun mirror AutomationStep.jsx's own manual
  // runs use (see applyProgressToRun, src/lib/automationScheduler.js), so "Return to automation"
  // works identically regardless of which one is actually driving a given cycle. onUpdate is
  // omitted: it only feeds AutomationStep.jsx's own local per-channel progress line, which doesn't
  // exist at this level and isn't needed here — the mirror only cares about phase-level onProgress.
  useEffect(() => {
    if (!session?.user?.id || !schedulerEnabled) {
      stopSchedulerTimer();
      return;
    }
    startScheduler({
      userId: session.user.id,
      onProgress: (evt) => setCurrentAutomationRun((prev) => applyProgressToRun(prev, evt)),
      onCycleEnd: () => setCurrentAutomationRun(null),
    });
    return () => stopSchedulerTimer();
  }, [schedulerEnabled, session?.user?.id]);

  // Navbar's idle-video-count badge — independent of whether the scheduler is enabled or a cycle is
  // live (an idle video is, by definition, NOT part of anything currently running), so this polls on
  // its own rather than piggybacking on either of the effects above.
  useEffect(() => {
    if (!session?.user?.id) {
      setIdleVideoCount(0);
      return;
    }
    let cancelled = false;
    async function poll() {
      try {
        const items = await listIncompleteVideos(session.user.id);
        if (!cancelled) setIdleVideoCount(items.filter((v) => v.waitingReason === 'idle').length);
      } catch (err) {
        console.error('[App] failed to poll idle video count', err);
      }
    }
    poll();
    const id = setInterval(poll, INCOMPLETE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session?.user?.id]);

  // Ask the browser to exempt this origin from automatic eviction under storage pressure — WisiTube
  // keeps rendered video/image/audio Blobs in IndexedDB (see src/lib/db.js) with no server-side
  // backup, so a silent eviction would be a real data loss, not just a cache miss. The user can
  // still clear data manually; this only opts out of the *automatic* kind. Not supported in every
  // browser and never guaranteed even where it is, so this is fire-and-forget with no blocking UI.
  useEffect(() => {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then((granted) => {
        console.log('Storage persisted:', granted);
      });
    }
  }, []);

  // Returning leg of the per-channel YouTube OAuth flow (api/youtube.js, action=callback redirects
  // here with these query params) — read once on mount, persisted to the channel via Supabase (see
  // src/lib/db.js), then stripped from the URL so a refresh doesn't replay it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connectedChannelId = params.get('youtube_connected');
    const ytError = params.get('youtube_error');
    if (connectedChannelId) {
      const ytName = params.get('yt_name') || '';
      const ytChannelId = params.get('yt_channel_id') || '';
      const ytRefresh = params.get('yt_refresh') || '';
      saveYoutubeConnection(connectedChannelId, {
        channelName: ytName,
        youtubeChannelId: ytChannelId,
        refreshToken: ytRefresh,
      })
        .then(() => {
          window.alert(`Connected to YouTube channel "${ytName}".`);
        })
        .catch((err) => window.alert(`Could not save the YouTube connection: ${String(err.message || err)}`));
      window.history.replaceState({}, '', window.location.pathname);
    } else if (ytError) {
      window.alert(`YouTube connection failed: ${ytError}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Autosave the open video to Supabase, debounced so fast edits don't hammer the table.
  useEffect(() => {
    if (!project || !projectId) return;
    const generation = generationRef.current;
    const timer = setTimeout(() => {
      if (generationRef.current !== generation) return; // a different video took over — discard
      if (!openVideoChannelId) {
        // Never seen a valid creation/resume point for this video (or it was cleared by
        // backToChannels/startNewProjectWithTopic) — writing null (or, before this guard existed,
        // whatever currentChannelId happened to be) would either corrupt or silently reassign the
        // video. Refuse and wait for the next debounce instead.
        console.warn('[autosave] refusing to save — no openVideoChannelId for the open video', projectId);
        return;
      }
      saveVideo({
        id: projectId,
        channelId: openVideoChannelId,
        createdAt: createdAt || Date.now(),
        updatedAt: Date.now(),
        topic: settings.topic,
        settings,
        ...project,
        // Frozen at save time so the channel dashboard never has to re-derive it (and risk
        // picking the raw topic — which can repeat across videos — over the generated title).
        displayTitle: project.titles?.[project.selectedTitle] || settings.topic?.slice(0, 60) || 'Untitled video',
        // Unlike idb-keyval's local writes, this now goes over the network and can genuinely fail
        // (auth, connectivity, RLS) — surface it instead of an unhandled promise rejection.
      }).catch((err) => console.error('[autosave] saveVideo failed', err));
    }, 800);
    return () => clearTimeout(timer);
  }, [project, settings, projectId, createdAt, openVideoChannelId]);

  // Phase 1: CreateStep only asks for title options — nothing is saved yet.
  function handleTitles(titles) {
    generationRef.current += 1;
    setTitleOptions(titles);
    setPendingPlan(null);
    setGenerationError('');
    setTab('titles');
  }

  // Persists whatever scenes have been generated so far under the in-progress video's id, so a
  // crash or refresh mid-generation never loses completed chunks — the video shows up in the
  // channel dashboard (incomplete but resumable) even if generation never finishes.
  //
  // channelIdVal is passed explicitly rather than read from openVideoChannelId state directly:
  // handleOutlineReady calls setOpenVideoChannelId(...) and then, in the same synchronous
  // invocation, kicks off runSceneGeneration → this function — React hasn't re-rendered yet at
  // that point, so persistPartial's own closure would still see the PREVIOUS render's (possibly
  // null) openVideoChannelId if it read the state directly instead. Passing the value down avoids
  // that staleness entirely.
  function persistPartial(plan, rawScenesSoFar, id, createdAtVal, channelIdVal) {
    if (!channelIdVal) {
      console.warn('[persistPartial] refusing to save — no channelId for the in-progress video', id);
      return;
    }
    saveVideo({
      id,
      channelId: channelIdVal,
      createdAt: createdAtVal,
      updatedAt: Date.now(),
      topic: settings.topic,
      settings,
      titles: [plan.title],
      selectedTitle: 0,
      description: plan.description,
      tags: plan.tags,
      thumbnails: plan.thumbnails,
      subtitles: true,
      references: plan.references,
      characterBible: plan.characterBible,
      scenes: buildScenesFromRaw(rawScenesSoFar, settings.contentType === 'static_background'),
      series: settings.series || null,
      // Comparison-only subject name from the chosen title — see the setProject call in
      // runSceneGeneration for what it's for.
      subject: plan.subject || null,
      displayTitle: plan.title || settings.topic?.slice(0, 60) || 'Untitled video',
      // Resolved once in handleOutlineReady (background image already uploaded to this video's own
      // Storage path there, if it needed to be) — carried through every partial save unchanged, same
      // as characterBible/references above. Omitted entirely for full_pipeline, so its saved shape
      // is byte-for-byte what it always was.
      ...(settings.contentType === 'static_background'
        ? { staticBackground: plan.staticBackground, staticTextStyle: plan.staticTextStyle, ...(plan.thumbnailStoragePath ? { thumbnailStoragePath: plan.thumbnailStoragePath } : {}) }
        : {}),
    });
  }

  async function runSceneGeneration(plan, id, createdAtVal, generation, channelIdVal) {
    const context = {
      topic: settings.topic,
      title: plan.title,
      language: settings.language,
      style: STYLES[settings.style].label,
      format: settings.format,
      imageProvider: settings.imageProvider,
      contentType: settings.contentType,
      characterBible: plan.characterBible,
      references: plan.references.map((r) => ({ id: r.id, label: r.label })),
      creativeOverride: currentChannel?.prompt_overrides?.scenes || null,
      // Same fallback as TitleSelectStep.jsx's own generate-outline call — per-video override falls
      // back to the channel default when unset.
      channelIntroEnabled: (settings.channelIntroEnabled !== undefined ? settings.channelIntroEnabled : currentChannel?.automation_channel_intro) === true,
      niche: currentChannel?.niche || '',
    };

    try {
      const { scenes, promisedFollowUp } = await generateAllScenes(plan.outline, context, (soFar, total) => {
        if (generationRef.current !== generation) return; // abandoned — a different video took over
        setSceneProgress({ current: soFar.length, total });
        persistPartial(plan, soFar, id, createdAtVal, channelIdVal);
      });
      if (generationRef.current !== generation) return;
      setProject({
        titles: [plan.title],
        selectedTitle: 0,
        description: plan.description,
        tags: plan.tags,
        thumbnails: plan.thumbnails,
        subtitles: true,
        references: plan.references,
        characterBible: plan.characterBible,
        scenes: buildScenesFromRaw(scenes, settings.contentType === 'static_background'),
        series: settings.series || null,
        // Bare proper name of the subject (from the chosen title — api/generate-outline.js's titles
        // mode). Comparison-only, never displayed: the Content Program Manager uses it as the
        // primary "already covered this" check (src/lib/contentProgramManager.js).
        subject: plan.subject || null,
        // Whatever the closing CTA promised for a future video (see api/generate-scenes.js's
        // promised_follow_up field) — null when the CTA was generic. Feeds
        // api/program-manager.js's pendingPromises context (ChannelDashboardStep.jsx) once this
        // video is saved, and is cleared to fulfilled (not this field itself) when a later
        // suggestion is started to address it — see ChannelDashboardStep.jsx's fulfillPromise.
        promisedFollowUp: promisedFollowUp || null,
        ...(settings.contentType === 'static_background'
          ? { staticBackground: plan.staticBackground, staticTextStyle: plan.staticTextStyle, ...(plan.thumbnailStoragePath ? { thumbnailStoragePath: plan.thumbnailStoragePath } : {}) }
          : {}),
      });
      setTab('storyboard');
    } catch (e) {
      if (generationRef.current !== generation) return;
      setGenerationError(String(e.message || e));
    }
  }

  // Phase 2: TitleSelectStep has already fetched the outline — persist the pieces we have so far
  // and kick off chunked scene generation in the background.
  async function handleOutlineReady(outlineData, title, angle, subject) {
    generationRef.current += 1;
    const generation = generationRef.current;
    const newProjectId = createId();
    const newCreatedAt = Date.now();
    setProjectId(newProjectId);
    setCreatedAt(newCreatedAt);
    // Captured once, here, at video-creation time — currentChannelId is safe to read directly in
    // this same synchronous call (it isn't being changed by this function), but the state setter
    // below won't be visible to this same invocation's own closures until the next render, so
    // runSceneGeneration/persistPartial are handed the local currentChannelId value explicitly
    // rather than reading openVideoChannelId back out of state.
    setOpenVideoChannelId(currentChannelId);
    setGenerationError('');

    // Reference files must survive reloads (IndexedDB) and later regenerations, so convert each
    // one to a plain Blob up front — same pattern as scene images (url + blob), since File objects
    // don't always survive structured-clone/IndexedDB round-trips as cleanly as Blobs do.
    const references = await Promise.all(
      (settings.references || [])
        .filter((r) => r.file)
        .map(async (r) => ({ id: r.id, label: r.label, file: new Blob([await r.file.arrayBuffer()], { type: r.file.type }) }))
    );

    const characterBible = (outlineData.character_bible || []).map((c) => ({
      id: c.id || crypto.randomUUID(),
      name: c.name || '',
      baseDescription: c.base_description || '',
      variants: Array.isArray(c.variants) ? c.variants.map((v) => ({ label: v.label || '', description: v.description || '' })) : [],
    }));

    // CreateStep.jsx's background/thumbnail controls only ever produce settings-scoped, in-memory
    // data (no videoId existed yet while the user was configuring them there) — resolve them into
    // this video's own durable form now that newProjectId is real. A freshly picked/generated
    // background Blob gets uploaded to Storage here (same deferred-upload precedent as reference
    // photos, see ExportStep.jsx); an untouched channel default is already durable at its own
    // Storage path and is simply carried forward as-is (no reupload, no extra cost) — same reuse
    // approach staticBackgroundRecipe.js's buildStaticBackgroundFromChannel uses for automation.
    let staticBackground = null;
    let staticTextStyle = null;
    let thumbnailStoragePath = null;
    if (settings.contentType === 'static_background') {
      const sb = settings.staticBackground || { type: 'color', color: '#111111' };
      if (sb.type === 'image' && sb.blob && !sb.imageStoragePath) {
        try {
          const path = await uploadMedia(session.user.id, newProjectId, 'static-background', 'bg', sb.blob);
          staticBackground = { type: 'image', imageStoragePath: path, url: URL.createObjectURL(sb.blob), blob: sb.blob };
        } catch (err) {
          console.error('[handleOutlineReady] failed to upload static background image, falling back to color', err);
          staticBackground = { type: 'color', color: sb.color || '#111111', imageStoragePath: null, url: null, blob: null };
        }
      } else {
        staticBackground = { type: sb.type || 'color', color: sb.color || '#111111', imageStoragePath: sb.imageStoragePath || null, url: null, blob: null };
      }
      staticTextStyle = settings.staticTextStyle || null;

      if (settings.thumbnailMode === 'manual' && settings.manualThumbnailFile) {
        try {
          thumbnailStoragePath = await uploadMedia(session.user.id, newProjectId, 'thumbnail', 'thumbnail', settings.manualThumbnailFile);
        } catch (err) {
          console.error('[handleOutlineReady] failed to upload manual thumbnail', err);
        }
      }
    }

    const plan = {
      title,
      angle,
      // Comparison-only proper-name of the subject, from the chosen title (see TitleSelectStep.jsx /
      // api/generate-outline.js titles mode). Never shown — feeds the anti-repetition check only.
      subject: (subject || '').trim(),
      description: outlineData.description || '',
      tags: outlineData.tags || [],
      thumbnails: outlineData.thumbnail_concepts || [],
      characterBible,
      references,
      outline: outlineData.outline || [],
      totalScenes: outlineData.total_scenes || 0,
      staticBackground,
      staticTextStyle,
      thumbnailStoragePath,
    };
    setPendingPlan(plan);
    setSceneProgress({ current: 0, total: plan.totalScenes });
    setTab('generating-scenes');

    await runSceneGeneration(plan, newProjectId, newCreatedAt, generation, currentChannelId);
  }

  function retryScenes() {
    if (!pendingPlan || !projectId) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    setGenerationError('');
    // Unlike handleOutlineReady above, this fires from a later, separate render (a user click),
    // so openVideoChannelId state has already settled to whatever handleOutlineReady set it to —
    // safe to read directly here.
    runSceneGeneration(pendingPlan, projectId, createdAt, generation, openVideoChannelId);
  }

  function backToTitlesFromFailure() {
    generationRef.current += 1;
    setPendingPlan(null);
    setGenerationError('');
    setSceneProgress({ current: 0, total: 0 });
    setTab('titles');
  }

  // Resume a project loaded from Supabase — object URLs (and the Blobs behind them) never survive
  // a reload, so they're rebuilt here: from an in-memory Blob if one's still on the record (rare —
  // stripBlobsForSync, src/lib/db.js, nulls those out before every save), otherwise downloaded fresh
  // from its Supabase Storage backup (Phase 3) via storagePath/audioStoragePath. Async because of
  // that download step — generationRef guards against a stale resume finishing after a newer one
  // (or a reset) already took over, same pattern as the scene-generation pipeline below.
  async function handleResume(record) {
    generationRef.current += 1;
    const generation = generationRef.current;
    setTitleOptions(null);
    setPendingPlan(null);
    setGenerationError('');
    setResuming(true);

    // Rebuilds usable blob: URLs for every ready image/audio/reference from their Supabase Storage
    // backups — shared with fullPipelineRecipe.js's automation-resume path (see
    // src/lib/mediaRehydration.js), since blob: URLs never survive a reload either way.
    let resumedProject = await rehydrateProjectMedia({
      titles: record.titles || [],
      selectedTitle: record.selectedTitle || 0,
      description: record.description || '',
      tags: record.tags || [],
      thumbnails: record.thumbnails || [],
      subtitles: !!record.subtitles,
      references: record.references || [],
      characterBible: record.characterBible || [],
      scenes: record.scenes || [],
      series: record.series || null,
      // Without these, a resumed static_background video would come back with no
      // staticBackground/staticTextStyle at all — StoryboardStep.jsx's seeding effect would then
      // treat it as never-configured and silently reseed from the channel's current defaults,
      // masking whatever this specific video actually had (its own override, or a channel default
      // that has since changed). rehydrateProjectMedia (below) restores the background image's
      // blob/url from imageStoragePath the same way it already does for scene images.
      staticBackground: record.staticBackground || null,
      staticTextStyle: record.staticTextStyle || null,
      // Not rebuilt into an object URL here (unlike images/audio above) — ExportStep does that
      // itself on mount, since it also needs the raw Blob for a same-mount YouTube upload without
      // re-fetching a blob: URL that may no longer be valid (see ExportStep.jsx runUpload).
      renderedVideoBlob: record.renderedVideoBlob || null,
      thumbnailStoragePath: record.thumbnailStoragePath || null,
      // Set once this video is actually published (automation's youtube phase, or a manual upload
      // from ExportStep) — carried through resume so ExportStep can tell it's already live and
      // refuse to offer a full re-upload (see its project.youtubeVideoId branch).
      youtubeVideoId: record.youtubeVideoId || null,
      pendingImageBatches: record.pendingImageBatches || [],
      batchRecoveryCycles: record.batchRecoveryCycles || 0,
      // Same reason as staticBackground/staticTextStyle above: without these, resuming this video
      // and letting its own autosave fire again would silently reset promise_fulfilled back to
      // false (saveVideo's default when the field is absent from the in-memory project), even if a
      // later suggestion had already fulfilled it.
      promisedFollowUp: record.promisedFollowUp || null,
      promiseFulfilled: !!record.promiseFulfilled,
      // Comparison-only subject name — same "carry it through resume or the next autosave drops it"
      // reason as the fields above.
      subject: record.subject || null,
    });

    if (generationRef.current !== generation) return; // a newer resume/reset took over meanwhile

    // Reopening a video with Gemini Batch jobs still in flight must never show whatever was true
    // the moment the tab closed — check on every batch this video has outstanding (and fill any
    // gap left by a job that failed, or never got submitted before an earlier close) before the
    // user ever sees it. A video with no pending batches skips this entirely — it's not a recovery
    // check for ordinary generation failures, only for the batch mechanism specifically.
    if (resumedProject.pendingImageBatches.length > 0) {
      try {
        resumedProject = await resumePendingBatches(resumedProject, {
          userId: session?.user?.id,
          videoId: record.id,
          channelId: record.channelId,
          settings: record.settings || settings,
          persist: (proj) =>
            saveVideo({
              id: record.id,
              channelId: record.channelId,
              createdAt: record.createdAt,
              updatedAt: Date.now(),
              topic: record.topic,
              settings: record.settings || settings,
              ...proj,
              displayTitle: record.displayTitle,
            }),
        });
      } catch (err) {
        console.error('[handleResume] resumePendingBatches failed', err);
      }
    }

    if (generationRef.current !== generation) return; // resumePendingBatches can take a while — recheck

    setSettings(record.settings || settings);
    setProject(resumedProject);
    setProjectId(record.id);
    setCreatedAt(record.createdAt || Date.now());
    // The video's own recorded channelId, not whatever currentChannelId happens to be — this is
    // the one value the autosave effect will use for every future save of this video, regardless
    // of which channel dashboard the user later browses to.
    setOpenVideoChannelId(record.channelId || null);
    // Resume only ever happens from within a channel's dashboard, so currentChannelId is already
    // set — this just guards against staleness (e.g. a video record whose channelId differs).
    if (record.channelId) setCurrentChannelId(record.channelId);
    const resumedIsStaticBackground = (record.settings || settings).contentType === 'static_background';
    const hasAllMedia =
      resumedProject.scenes.length > 0 && resumedProject.scenes.every((s) => isSceneMediaReady(s, resumedIsStaticBackground));
    setTab(hasAllMedia ? 'editor' : 'storyboard');
    setResuming(false);
  }

  // Explicit reset so opening the Create tab from the channel dashboard never silently overwrites the open video.
  // series is only non-null when started from a Content Program Manager suggestion that belongs
  // to one — always set explicitly (not merged) so a manual "New video" doesn't inherit a stale
  // series from whatever suggestion was started last.
  //
  // content_type is read via a fresh loadChannel(currentChannelId) here rather than off currentChannel
  // state — that state is only populated asynchronously, by ChannelDashboardStep's own mount effect
  // (onChannelChange), so it can still be null (first open of a channel this session) or, worse,
  // still hold the PREVIOUS channel's record (switched channels and clicked "+ New video" before the
  // new one's load finished) at the exact moment this function needs it. A direct fetch here is
  // correct regardless of any other component's loading timing, instead of merely reducing the odds
  // of catching it mid-flight.
  async function startNewProjectWithTopic(topic, series = null) {
    generationRef.current += 1;
    setProject(null);
    setProjectId(null);
    setCreatedAt(null);
    setOpenVideoChannelId(null);
    setTitleOptions(null);
    setPendingPlan(null);
    setGenerationError('');
    setSceneProgress({ current: 0, total: 0 });

    let contentType = 'full_pipeline';
    if (currentChannelId) {
      try {
        const ch = await loadChannel(currentChannelId);
        contentType = ch?.content_type || 'full_pipeline';
      } catch (err) {
        console.error('[startNewProjectWithTopic] failed to load channel for content_type', err);
      }
    }

    setSettings((s) => ({ ...s, topic, series, contentType }));
    setTab('create');
  }

  function startNewProject() {
    startNewProjectWithTopic('');
  }

  function openChannel(channel) {
    // Cleared up front rather than left as whatever channel was open before — currentChannel is only
    // repopulated asynchronously once ChannelDashboardStep's own load finishes (via onChannelChange),
    // so without this reset, anything reading currentChannel during that window (today:
    // startNewProjectWithTopic, though it no longer relies on it — potentially other code later) would
    // silently see the PREVIOUS channel's data instead of an explicit "not loaded yet".
    setCurrentChannel(null);
    setCurrentChannelId(channel.id);
    setCurrentChannelName(channel.name || '');
  }

  // Fully exits the current channel — used by the top-level "Channels" breadcrumb segment. Closes
  // whatever video was open (same reset shape as startNewProjectWithTopic) rather than leaving it
  // dangling in memory for the autosave guard to merely refuse to save — returning to the channel
  // list means there is no longer an open video, full stop. generationRef is bumped for the same
  // reason startNewProjectWithTopic bumps it: a handleResume (or scene-generation) call already in
  // flight when this fires must recognize it's now stale and abort instead of resurrecting
  // project/projectId after this reset.
  function backToChannels() {
    generationRef.current += 1;
    setCurrentChannelId(null);
    setCurrentChannelName('');
    setCurrentChannel(null);
    setOpenVideoChannelId(null);
    setProject(null);
    setProjectId(null);
    setCreatedAt(null);
    setTab('channels');
  }

  const hasPlan = !!project;
  const hasMedia = hasPlan && project.scenes.every((s) => isSceneMediaReady(s, settings.contentType === 'static_background'));
  const currentVideoTitle = hasPlan
    ? project.titles?.[project.selectedTitle] || settings.topic?.slice(0, 60) || 'Untitled video'
    : pendingPlan?.title || '';

  // The chunked scene-generation pipeline runs unattended across several sequential API calls —
  // long enough that navigating away mid-run and coming back later would otherwise be surprising
  // (the background work would still land on 'storyboard' whenever it finished). Locking nav
  // during this phase keeps the dedicated Retry / Back-to-titles buttons as the only way out.
  const inFlight = tab === 'generating-scenes';

  const tabs = [
    { id: 'channels', label: 'Channels', disabled: inFlight },
    { id: 'automation', label: 'Automation', disabled: inFlight },
    { id: 'create', label: 'Create', disabled: !currentChannelId || inFlight },
    { id: 'storyboard', label: 'Storyboard', disabled: !hasPlan || inFlight },
    { id: 'editor', label: 'Editor', disabled: !hasMedia || inFlight },
    { id: 'export', label: 'Export', disabled: !hasMedia || inFlight },
  ];

  const breadcrumbBtn = {
    background: 'none',
    border: 'none',
    padding: 0,
    ...mono,
    fontSize: 12,
    color: T.textSecondary,
    cursor: 'pointer',
    textDecoration: 'underline',
  };

  if (session === undefined) return null; // still checking for an existing session
  if (!session) return <AuthScreen />;
  if (resuming) return <FullScreenLoader title="Reopening your video…" subtitle="Restoring images and audio from your backup" />;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: T.bg }}>
      <Navbar
        tabs={tabs}
        activeTab={tab}
        onTab={setTab}
        isMobile={isMobile}
        userEmail={session.user?.email}
        onSignOut={() => supabase.auth.signOut()}
        hasActiveAutomation={!!currentAutomationRun}
        idleVideoCount={idleVideoCount}
        onReturnToAutomation={() => setTab('automation-mirror')}
      />

      <main style={{ flex: 1, width: '100%', maxWidth: 1200, margin: '0 auto', padding: isMobile ? '20px 14px' : '32px 20px' }}>
        {currentChannelId && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 20 }}>
            <button onClick={backToChannels} disabled={inFlight} style={{ ...breadcrumbBtn, opacity: inFlight ? 0.5 : 1 }}>
              Channels
            </button>
            <span style={{ ...mono, fontSize: 12, color: T.textMuted }}>/</span>
            {tab === 'channels' ? (
              <span style={{ ...mono, fontSize: 12, color: T.text, fontWeight: 700 }}>{currentChannelName || 'Channel'}</span>
            ) : (
              <button onClick={() => setTab('channels')} disabled={inFlight} style={{ ...breadcrumbBtn, opacity: inFlight ? 0.5 : 1 }}>
                {currentChannelName || 'Channel'}
              </button>
            )}
            {tab !== 'channels' && currentVideoTitle && (
              <>
                <span style={{ ...mono, fontSize: 12, color: T.textMuted }}>/</span>
                <span style={{ ...mono, fontSize: 12, color: T.text, fontWeight: 700 }}>{currentVideoTitle}</span>
              </>
            )}
          </div>
        )}

        {tab === 'channels' &&
          (currentChannelId ? (
            <ChannelDashboardStep
              channelId={currentChannelId}
              userId={session.user?.id}
              onResume={handleResume}
              onNewVideo={startNewProject}
              onBack={backToChannels}
              onChannelChange={(ch) => {
                setCurrentChannelName(ch?.name || '');
                setCurrentChannel(ch);
              }}
              onStartVideoFromSuggestion={startNewProjectWithTopic}
              isMobile={isMobile}
            />
          ) : (
            <ChannelsListStep onOpenChannel={openChannel} isMobile={isMobile} />
          ))}

        {tab === 'automation' && (
          <AutomationStep
            userId={session.user?.id}
            isMobile={isMobile}
            onRunUpdate={setCurrentAutomationRun}
            onSchedulerEnabledChange={setSchedulerEnabled}
          />
        )}

        {tab === 'automation-mirror' && (
          <AutomationMirrorStep run={currentAutomationRun} userId={session.user?.id} onResume={handleResume} isMobile={isMobile} />
        )}

        {tab === 'create' && (
          <>
            <div style={{ marginBottom: 28 }}>
              <h1 style={{ fontFamily: FONT.display, fontSize: isMobile ? 30 : 40, margin: 0, color: T.text, lineHeight: 1.15 }}>
                One topic in.
                <br />
                One animated video out.
              </h1>
              <p style={{ fontFamily: FONT.ui, fontSize: 14, color: T.textSecondary, marginTop: 12, maxWidth: 620, lineHeight: 1.6 }}>
                WisiTube writes the script, generates the voiceover and the illustrations, animates every scene in sync with the narration,
                and gives you a timeline to fine-tune — then exports a ready-to-upload YouTube video. Free AI, no watermarks.
              </p>
            </div>
            <CreateStep settings={settings} setSettings={setSettings} onTitles={handleTitles} channel={currentChannel} isMobile={isMobile} />
          </>
        )}

        {tab === 'titles' && (
          <TitleSelectStep
            titleOptions={titleOptions}
            settings={settings}
            onOutlineReady={handleOutlineReady}
            onBack={() => setTab('create')}
            channel={currentChannel}
          />
        )}

        {tab === 'generating-scenes' &&
          (generationError ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div
                style={{
                  ...card,
                  borderColor: T.primaryBorder,
                  background: T.primaryLight,
                  padding: 14,
                  fontSize: 13,
                  color: T.primary,
                  fontFamily: FONT.ui,
                }}
              >
                {generationError}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={retryScenes} style={btnGhost}>
                  Retry
                </button>
                <button onClick={backToTitlesFromFailure} style={btnGhost}>
                  ← Back to titles
                </button>
              </div>
            </div>
          ) : (
            <FullScreenLoader
              title="Writing your scenes…"
              subtitle="Claude is turning the outline into narration and image prompts, chapter by chapter"
              progress={sceneProgress}
            />
          ))}

        {tab === 'storyboard' && project && (
          <StoryboardStep
            project={project}
            setProject={setProject}
            settings={settings}
            onReady={() => setTab('editor')}
            channel={currentChannel}
            channelId={currentChannelId}
            videoId={projectId}
            userId={session.user?.id}
            isMobile={isMobile}
          />
        )}

        {tab === 'editor' && project && (
          <EditorStep
            project={project}
            setProject={setProject}
            settings={settings}
            onExport={() => setTab('export')}
            channelId={currentChannelId}
            videoId={projectId}
            userId={session.user?.id}
            isMobile={isMobile}
          />
        )}

        {tab === 'export' && project && (
          <ExportStep
            project={project}
            setProject={setProject}
            settings={settings}
            channel={currentChannel}
            channelId={currentChannelId}
            videoId={projectId}
            userId={session.user?.id}
            isMobile={isMobile}
          />
        )}
      </main>

      <Footer isMobile={isMobile} />
    </div>
  );
}
