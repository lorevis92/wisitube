import React, { useEffect, useState } from 'react';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import CreateStep from './steps/CreateStep';
import StoryboardStep from './steps/StoryboardStep';
import EditorStep from './steps/EditorStep';
import ExportStep from './steps/ExportStep';
import { T, FONT } from './theme';

let sceneIdCounter = 1;

export default function App() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 760);
  const [tab, setTab] = useState('create');
  const [settings, setSettings] = useState({
    topic: '',
    style: 'facestick',
    voice: 'nova',
    length: 'short',
    format: '16:9',
    language: 'English',
  });
  const [project, setProject] = useState(null);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 760);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function handlePlan(plan) {
    setProject({
      titles: plan.titles || [],
      selectedTitle: 0,
      description: plan.description || '',
      tags: plan.tags || [],
      thumbnails: plan.thumbnail_concepts || [],
      subtitles: settings.format === '9:16',
      scenes: (plan.scenes || []).map((s) => ({
        id: sceneIdCounter++,
        narration: s.narration || '',
        imagePrompt: s.image_prompt || '',
        animation: s.animation || 'zoom_in',
        seed: Math.floor(Math.random() * 999999),
        pad: 0.3,
        imageStatus: 'idle',
        imageUrl: '',
        audioStatus: 'idle',
        audioUrl: '',
        audioDuration: 0,
      })),
    });
    setTab('storyboard');
  }

  const hasPlan = !!project;
  const hasMedia = hasPlan && project.scenes.every((s) => s.imageStatus === 'ready' && s.audioStatus === 'ready');

  const tabs = [
    { id: 'create', label: 'Create' },
    { id: 'storyboard', label: 'Storyboard', disabled: !hasPlan },
    { id: 'editor', label: 'Editor', disabled: !hasMedia },
    { id: 'export', label: 'Export', disabled: !hasMedia },
  ];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: T.bg }}>
      <Navbar tabs={tabs} activeTab={tab} onTab={setTab} isMobile={isMobile} />

      <main style={{ flex: 1, width: '100%', maxWidth: 1200, margin: '0 auto', padding: isMobile ? '20px 14px' : '32px 20px' }}>
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
