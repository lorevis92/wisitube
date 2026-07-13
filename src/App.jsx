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
import FullScreenLoader from './components/FullScreenLoader';
import { T, FONT, mono, card, btnGhost } from './theme';
import { createId, saveVideo, saveYoutubeConnection } from './lib/db';
import { STYLES } from './lib/pollinations';
import { generateAllScenes } from './lib/sceneOrchestrator';

let sceneIdCounter = 1;
let beatIdCounter = 1;

// Array.isArray/length guard: projects saved before the 2-image-beat model lack `images`
// entirely — treat those as not-ready rather than crashing on scenes.every() over undefined.
const isSceneMediaReady = (s) =>
  Array.isArray(s.images) && s.images.length > 0 && s.images.every((im) => im.status === 'ready') && s.audioStatus === 'ready';

// Turns the raw { narration, image_beats } scenes returned by api/generate-scenes.js into the
// internal scene/beat shape the rest of the app works with — shared by the incremental partial
// save (during chunked generation) and the final assembly, so both stay in sync.
function buildScenesFromRaw(rawScenes) {
  return (rawScenes || []).map((s) => {
    const beats = Array.isArray(s.image_beats) && s.image_beats.length ? s.image_beats.slice(0, 2) : [{}, {}];
    while (beats.length < 2) beats.push({});
    return {
      id: sceneIdCounter++,
      narration: s.narration || '',
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
      pad: 0.3,
      audioStatus: 'idle',
      audioUrl: '',
      audioBlob: null,
      audioDuration: 0,
    };
  });
}

export default function App() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 760);
  const [tab, setTab] = useState('channels');
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
    imageProvider: 'pollinations',
    lengthMinutes: 5,
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

  // Returning leg of the per-channel YouTube OAuth flow (api/youtube-callback.js redirects here
  // with these query params) — read once on mount, persisted to the channel via IndexedDB (the
  // only storage WisiTube has), then stripped from the URL so a refresh doesn't replay it.
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
      }).then(() => {
        window.alert(`Connected to YouTube channel "${ytName}".`);
      });
      window.history.replaceState({}, '', window.location.pathname);
    } else if (ytError) {
      window.alert(`YouTube connection failed: ${ytError}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Autosave the open video to IndexedDB, debounced so fast edits don't hammer the store.
  useEffect(() => {
    if (!project || !projectId) return;
    const generation = generationRef.current;
    const timer = setTimeout(() => {
      if (generationRef.current !== generation) return; // a different video took over — discard
      saveVideo({
        id: projectId,
        channelId: currentChannelId,
        createdAt: createdAt || Date.now(),
        updatedAt: Date.now(),
        topic: settings.topic,
        settings,
        ...project,
        // Frozen at save time so the channel dashboard never has to re-derive it (and risk
        // picking the raw topic — which can repeat across videos — over the generated title).
        displayTitle: project.titles?.[project.selectedTitle] || settings.topic?.slice(0, 60) || 'Untitled video',
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [project, settings, projectId, createdAt, currentChannelId]);

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
  function persistPartial(plan, rawScenesSoFar, id, createdAtVal) {
    saveVideo({
      id,
      channelId: currentChannelId,
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
      scenes: buildScenesFromRaw(rawScenesSoFar),
      series: settings.series || null,
      displayTitle: plan.title || settings.topic?.slice(0, 60) || 'Untitled video',
    });
  }

  async function runSceneGeneration(plan, id, createdAtVal, generation) {
    const context = {
      topic: settings.topic,
      title: plan.title,
      language: settings.language,
      style: STYLES[settings.style].label,
      format: settings.format,
      imageProvider: settings.imageProvider,
      characterBible: plan.characterBible,
      references: plan.references.map((r) => ({ id: r.id, label: r.label })),
    };

    try {
      const scenes = await generateAllScenes(plan.outline, context, (soFar, total) => {
        if (generationRef.current !== generation) return; // abandoned — a different video took over
        setSceneProgress({ current: soFar.length, total });
        persistPartial(plan, soFar, id, createdAtVal);
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
        scenes: buildScenesFromRaw(scenes),
        series: settings.series || null,
      });
      setTab('storyboard');
    } catch (e) {
      if (generationRef.current !== generation) return;
      setGenerationError(String(e.message || e));
    }
  }

  // Phase 2: TitleSelectStep has already fetched the outline — persist the pieces we have so far
  // and kick off chunked scene generation in the background.
  async function handleOutlineReady(outlineData, title, angle) {
    generationRef.current += 1;
    const generation = generationRef.current;
    const newProjectId = createId();
    const newCreatedAt = Date.now();
    setProjectId(newProjectId);
    setCreatedAt(newCreatedAt);
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

    const plan = {
      title,
      angle,
      description: outlineData.description || '',
      tags: outlineData.tags || [],
      thumbnails: outlineData.thumbnail_concepts || [],
      characterBible,
      references,
      outline: outlineData.outline || [],
      totalScenes: outlineData.total_scenes || 0,
    };
    setPendingPlan(plan);
    setSceneProgress({ current: 0, total: plan.totalScenes });
    setTab('generating-scenes');

    await runSceneGeneration(plan, newProjectId, newCreatedAt, generation);
  }

  function retryScenes() {
    if (!pendingPlan || !projectId) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    setGenerationError('');
    runSceneGeneration(pendingPlan, projectId, createdAt, generation);
  }

  function backToTitlesFromFailure() {
    generationRef.current += 1;
    setPendingPlan(null);
    setGenerationError('');
    setSceneProgress({ current: 0, total: 0 });
    setTab('titles');
  }

  // Resume a project loaded from IndexedDB — object URLs never survive a reload, so they're
  // rebuilt here from the stored Blobs before the project goes into state.
  function handleResume(record) {
    generationRef.current += 1;
    setTitleOptions(null);
    setPendingPlan(null);
    setGenerationError('');
    const scenes = (record.scenes || []).map((s) => ({
      ...s,
      images: (s.images || []).map((im) => ({
        ...im,
        url: im.blob ? URL.createObjectURL(im.blob) : im.url,
      })),
      audioUrl: s.audioBlob ? URL.createObjectURL(s.audioBlob) : s.audioUrl,
    }));
    setSettings(record.settings || settings);
    setProject({
      titles: record.titles || [],
      selectedTitle: record.selectedTitle || 0,
      description: record.description || '',
      tags: record.tags || [],
      thumbnails: record.thumbnails || [],
      subtitles: !!record.subtitles,
      references: record.references || [],
      characterBible: record.characterBible || [],
      scenes,
      series: record.series || null,
    });
    setProjectId(record.id);
    setCreatedAt(record.createdAt || Date.now());
    // Resume only ever happens from within a channel's dashboard, so currentChannelId is already
    // set — this just guards against staleness (e.g. a video record whose channelId differs).
    if (record.channelId) setCurrentChannelId(record.channelId);
    const hasAllMedia = scenes.length > 0 && scenes.every(isSceneMediaReady);
    setTab(hasAllMedia ? 'editor' : 'storyboard');
  }

  // Explicit reset so opening the Create tab from the channel dashboard never silently overwrites the open video.
  // series is only non-null when started from a Content Program Manager suggestion that belongs
  // to one — always set explicitly (not merged) so a manual "New video" doesn't inherit a stale
  // series from whatever suggestion was started last.
  function startNewProjectWithTopic(topic, series = null) {
    generationRef.current += 1;
    setProject(null);
    setProjectId(null);
    setCreatedAt(null);
    setTitleOptions(null);
    setPendingPlan(null);
    setGenerationError('');
    setSceneProgress({ current: 0, total: 0 });
    setSettings((s) => ({ ...s, topic, series }));
    setTab('create');
  }

  function startNewProject() {
    startNewProjectWithTopic('');
  }

  function openChannel(channel) {
    setCurrentChannelId(channel.id);
    setCurrentChannelName(channel.name || '');
  }

  // Fully exits the current channel — used by the top-level "Channels" breadcrumb segment.
  function backToChannels() {
    setCurrentChannelId(null);
    setCurrentChannelName('');
    setCurrentChannel(null);
    setTab('channels');
  }

  const hasPlan = !!project;
  const hasMedia = hasPlan && project.scenes.every(isSceneMediaReady);
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

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: T.bg }}>
      <Navbar tabs={tabs} activeTab={tab} onTab={setTab} isMobile={isMobile} />

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
            <CreateStep settings={settings} setSettings={setSettings} onTitles={handleTitles} isMobile={isMobile} />
          </>
        )}

        {tab === 'titles' && (
          <TitleSelectStep
            titleOptions={titleOptions}
            settings={settings}
            onOutlineReady={handleOutlineReady}
            onBack={() => setTab('create')}
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
            channelId={currentChannelId}
            videoId={projectId}
            isMobile={isMobile}
          />
        )}

        {tab === 'editor' && project && (
          <EditorStep project={project} setProject={setProject} settings={settings} onExport={() => setTab('export')} isMobile={isMobile} />
        )}

        {tab === 'export' && project && (
          <ExportStep
            project={project}
            settings={settings}
            channel={currentChannel}
            channelId={currentChannelId}
            videoId={projectId}
            isMobile={isMobile}
          />
        )}
      </main>

      <Footer isMobile={isMobile} />
    </div>
  );
}
