import React, { useEffect, useRef, useState } from 'react';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import ProjectsStep from './steps/ProjectsStep';
import CreateStep from './steps/CreateStep';
import StoryboardStep from './steps/StoryboardStep';
import EditorStep from './steps/EditorStep';
import ExportStep from './steps/ExportStep';
import { T, FONT } from './theme';
import { createId, saveProject } from './lib/db';

let sceneIdCounter = 1;
let beatIdCounter = 1;

// Array.isArray/length guard: projects saved before the 2-image-beat model lack `images`
// entirely — treat those as not-ready rather than crashing on scenes.every() over undefined.
const isSceneMediaReady = (s) =>
  Array.isArray(s.images) && s.images.length > 0 && s.images.every((im) => im.status === 'ready') && s.audioStatus === 'ready';

export default function App() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 760);
  const [tab, setTab] = useState('create');
  const [settings, setSettings] = useState({
    topic: '',
    style: 'facestick',
    voice: 'af_heart',
    length: 'short',
    format: '16:9',
    language: 'English',
    references: [],
    characterHints: [],
    generalNotes: '',
  });
  const [project, setProject] = useState(null);
  const [projectId, setProjectId] = useState(null);
  const [createdAt, setCreatedAt] = useState(null);
  // Bumped every time the open project is switched (new/resume/reset) so a debounced save
  // scheduled for the *previous* project can detect it's stale and refuse to write, even if the
  // effect-cleanup cancellation below ever fails to fire in time (e.g. a future refactor drops a
  // dependency from the array below — there's no exhaustive-deps lint in this project to catch it).
  const generationRef = useRef(0);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 760);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Autosave the open project to IndexedDB, debounced so fast edits don't hammer the store.
  useEffect(() => {
    if (!project || !projectId) return;
    const generation = generationRef.current;
    const timer = setTimeout(() => {
      if (generationRef.current !== generation) return; // a different project took over — discard
      saveProject({
        id: projectId,
        createdAt: createdAt || Date.now(),
        updatedAt: Date.now(),
        topic: settings.topic,
        settings,
        ...project,
        // Frozen at save time so the Projects dashboard never has to re-derive it (and risk
        // picking the raw topic — which can repeat across projects — over the generated title).
        displayTitle: project.titles?.[project.selectedTitle] || settings.topic?.slice(0, 60) || 'Untitled project',
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [project, settings, projectId, createdAt]);

  async function handlePlan(plan) {
    generationRef.current += 1;
    setProjectId(createId());
    setCreatedAt(Date.now());
    // Reference files must survive reloads (IndexedDB) and later regenerations, so convert each
    // one to a plain Blob up front — same pattern as scene images (url + blob), since File objects
    // don't always survive structured-clone/IndexedDB round-trips as cleanly as Blobs do.
    const references = await Promise.all(
      (settings.references || [])
        .filter((r) => r.file)
        .map(async (r) => ({ id: r.id, label: r.label, file: new Blob([await r.file.arrayBuffer()], { type: r.file.type }) }))
    );
    setProject({
      titles: plan.titles || [],
      selectedTitle: 0,
      description: plan.description || '',
      tags: plan.tags || [],
      thumbnails: plan.thumbnail_concepts || [],
      subtitles: settings.format === '9:16',
      references,
      // Text-only, no Blobs involved — survives IndexedDB round-trips with a plain passthrough.
      characterBible: (plan.character_bible || []).map((c) => ({
        id: c.id || crypto.randomUUID(),
        name: c.name || '',
        baseDescription: c.base_description || '',
        variants: Array.isArray(c.variants) ? c.variants.map((v) => ({ label: v.label || '', description: v.description || '' })) : [],
      })),
      scenes: (plan.scenes || []).map((s) => {
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
      }),
    });
    setTab('storyboard');
  }

  // Resume a project loaded from IndexedDB — object URLs never survive a reload, so they're
  // rebuilt here from the stored Blobs before the project goes into state.
  function handleResume(record) {
    generationRef.current += 1;
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
    });
    setProjectId(record.id);
    setCreatedAt(record.createdAt || Date.now());
    const hasAllMedia = scenes.length > 0 && scenes.every(isSceneMediaReady);
    setTab(hasAllMedia ? 'editor' : 'storyboard');
  }

  // Explicit reset so opening the Create tab from Projects never silently overwrites the open project.
  function startNewProject() {
    generationRef.current += 1;
    setProject(null);
    setProjectId(null);
    setCreatedAt(null);
    setSettings((s) => ({ ...s, topic: '' }));
    setTab('create');
  }

  const hasPlan = !!project;
  const hasMedia = hasPlan && project.scenes.every(isSceneMediaReady);

  const tabs = [
    { id: 'projects', label: 'Projects' },
    { id: 'create', label: 'Create' },
    { id: 'storyboard', label: 'Storyboard', disabled: !hasPlan },
    { id: 'editor', label: 'Editor', disabled: !hasMedia },
    { id: 'export', label: 'Export', disabled: !hasMedia },
  ];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: T.bg }}>
      <Navbar tabs={tabs} activeTab={tab} onTab={setTab} isMobile={isMobile} />

      <main style={{ flex: 1, width: '100%', maxWidth: 1200, margin: '0 auto', padding: isMobile ? '20px 14px' : '32px 20px' }}>
        {tab === 'projects' && <ProjectsStep onResume={handleResume} onNewProject={startNewProject} isMobile={isMobile} />}

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
            <CreateStep settings={settings} setSettings={setSettings} onPlan={handlePlan} isMobile={isMobile} />
          </>
        )}

        {tab === 'storyboard' && project && (
          <StoryboardStep
            project={project}
            setProject={setProject}
            settings={settings}
            onReady={() => setTab('editor')}
            isMobile={isMobile}
          />
        )}

        {tab === 'editor' && project && (
          <EditorStep project={project} setProject={setProject} settings={settings} onExport={() => setTab('export')} isMobile={isMobile} />
        )}

        {tab === 'export' && project && <ExportStep project={project} settings={settings} isMobile={isMobile} />}
      </main>

      <Footer isMobile={isMobile} />
    </div>
  );
}
