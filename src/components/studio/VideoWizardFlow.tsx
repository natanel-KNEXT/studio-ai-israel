import { useState, useEffect, useCallback } from 'react';
import {
  ArrowRight, Loader2, Download, Play, Mic, MicOff,
  Save, Wand2, UserCircle, ChevronDown, ChevronUp,
  ImageIcon, Video, Volume2, Check, X, Edit3, RefreshCw,
  FileText, Sparkles, Plus, Globe, Link2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useSpeechToText } from '@/hooks/use-speech-to-text';
import {
  runwayService, heygenService, storageService, voiceCloneService, composeService,
  voiceService, websiteScraperService, kreaService, heygenExtendedService,
  type Brand, type WebsiteScrapeResult,
} from '@/services/creativeService';
import { projectService } from '@/services/projectService';
import { supabase } from '@/integrations/supabase/client';
import { FileUploadZone } from '@/components/FileUploadZone';
import { CostApprovalDialog, buildVideoGenerationEstimates, type CostEstimate } from '@/components/studio/CostApprovalDialog';
import { VoiceDictationButton } from '@/components/VoiceDictationButton';

interface SavedAvatar { id: string; name: string; image_url: string; style: string; }
interface SavedVoice {
  id: string;
  name: string;
  audio_url: string;
  type: string;
  provider_voice_id?: string | null;
  is_verified?: boolean;
  verification_status?: string;
  verification_selected_model?: string | null;
}

interface ScriptScene {
  id: number;
  title: string;
  speaker: string;
  spokenText: string;
  visualDescription: string;
  backgroundAction?: string;
  subtitleText: string;
  icons: string[];
  duration: number;
  transition: string;
  cameraDirection?: string;
  environment?: string;
  characters?: string;
  videoStyle?: string;
}

interface GeneratedScript {
  title: string;
  duration: number;
  script: string;
  scenes: ScriptScene[];
  style: { tone?: string; pace?: string; music?: string; cinematicStyle?: string };
}

interface VideoWizardFlowProps {
  avatars: SavedAvatar[];
  voices: SavedVoice[];
  activeBrand: Brand | undefined;
  activeBrandId: string | null;
  buildPrompt: (base: string) => string;
  initialCategory: string;
  brandDepartments: string[];
  onBack: () => void;
  onClose: () => void;
  /** If provided, restore session from this data */
  restoredSession?: VideoWizardSession | null;
  /** Called whenever session-worthy state changes */
  onSessionChange?: (session: VideoWizardSession) => void;
}

type VideoType = 'marketing' | 'podcast' | 'episode';

interface DurationPreset {
  label: string;
  seconds: number;
  videoTypes: VideoType[];
}

const DURATION_PRESETS: DurationPreset[] = [
  { label: '30 שניות', seconds: 30, videoTypes: ['marketing'] },
  { label: '40 שניות', seconds: 40, videoTypes: ['marketing'] },
  { label: '60 שניות', seconds: 60, videoTypes: ['marketing'] },
  { label: '2 דקות', seconds: 120, videoTypes: ['podcast', 'episode'] },
  { label: '3 דקות', seconds: 180, videoTypes: ['podcast', 'episode'] },
  { label: '4 דקות', seconds: 240, videoTypes: ['episode'] },
  { label: '5 דקות', seconds: 300, videoTypes: ['podcast', 'episode'] },
  { label: '10 דקות', seconds: 600, videoTypes: ['podcast'] },
];

const VIDEO_TYPE_OPTIONS: { value: VideoType; label: string; desc: string; icon: string; maxDuration: number }[] = [
  { value: 'marketing', label: 'שיווקי קצר', desc: '30–60 שניות • הוק + ערך + CTA', icon: '📢', maxDuration: 60 },
  { value: 'podcast', label: 'פודקאסט / Talking Head', desc: '2–10 דקות • קריינות + B-Roll', icon: '🎙️', maxDuration: 600 },
  { value: 'episode', label: 'אפיזודה AI', desc: '3–5 דקות • סצנות + קריינות', icon: '🎬', maxDuration: 300 },
];

const formatDuration = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s} שניות`;
  if (s === 0) return `${m} דקות`;
  return `${m}:${String(s).padStart(2, '0')} דקות`;
};

export interface VideoWizardSession {
  step: number;
  prompt: string;
  selectedAvatarIds: string[];
  selectedVoiceIds: string[];
  useAiVoice: boolean;
  videoStyle: string;
  generatedScript: GeneratedScript | null;
  uploadedImages: string[];
  resultVideoUrl: string | null;
  selectedCategory: string;
  customCategory: string;
  websiteUrl: string;
  improvePrompt: string;
  videoType: VideoType;
  targetDurationSec: number;
}

const RUNWAY_PROMPT_MAX_CHARS = 900;
const NARRATION_MAX_CHARS = 4500;
const RUNWAY_STATUS_POLL_MS = 5000;
const COMPOSE_STATUS_POLL_MS = 3000;
const RUNWAY_MAX_POLL_ATTEMPTS = 240;
const HEYGEN_MAX_POLL_ATTEMPTS = 180;
const CREDITS_CHECK_TIMEOUT_MS = 20000;
const KREA_GENERATION_TIMEOUT_MS = 360000;
const HEYGEN_GENERATION_TIMEOUT_MS = 900000;
const KREA_FALLBACK_TIMEOUT_MS = 360000; // 6min outer timeout (inner loop polls every 5s for 5min)

const DUMMY_RUNWAY_TASK_ID = '00000000-0000-0000-0000-000000000000';
const DUMMY_COMPOSE_RENDER_ID = '00000000-0000-0000-0000-000000000000';

type DebugLogStatus = 'info' | 'success' | 'warn' | 'error';

interface GenerationDebugLog {
  timestamp: string;
  runId: string;
  step: string;
  status: DebugLogStatus;
  message: string;
  meta?: Record<string, unknown>;
}

interface ProviderHealth {
  runway: 'healthy' | 'degraded' | 'unavailable';
  heygen: 'healthy' | 'degraded' | 'unavailable';
  krea: 'healthy' | 'degraded' | 'unavailable';
  compose: 'healthy' | 'degraded' | 'unavailable';
  credits: 'healthy' | 'degraded' | 'unavailable';
}

interface PreflightResult {
  ok: boolean;
  runId: string;
  checkedAt: string;
  errors: string[];
  warnings: string[];
  providerHealth: ProviderHealth;
  payloadPreview: Record<string, unknown>;
}

const toRunwayPrompt = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, RUNWAY_PROMPT_MAX_CHARS);
const toNarrationText = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, NARRATION_MAX_CHARS);

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const isRunwayCreditsErrorMessage = (value: unknown): boolean => {
  const message = typeof value === 'string' ? value.toLowerCase() : '';
  return (
    message.includes('not enough credits') ||
    message.includes('you do not have enough credits') ||
    message.includes('אין מספיק קרדיט') ||
    message.includes('אין מספיק קרדיטים') ||
    message.includes('נגמרו הקרדיטים') ||
    message.includes('קרדיטים לספק הווידאו')
  );
};

const isKreaCreditsErrorMessage = (value: unknown): boolean => {
  const message = typeof value === 'string' ? value.toLowerCase() : '';
  return (
    message.includes('insufficient_balance') ||
    message.includes('krea video error: 402') ||
    message.includes('אין מספיק קרדיט') ||
    message.includes('נגמרו הקרדיטים')
  );
};

const isProviderConfigErrorMessage = (value: unknown): boolean => {
  const message = typeof value === 'string' ? value.toLowerCase() : '';
  return (
    message.includes('not configured') ||
    message.includes('לא מוגדר') ||
    message.includes('missing') ||
    message.includes('מפתח')
  );
};

const isHeygenUnavailableErrorMessage = (value: unknown): boolean => {
  const message = typeof value === 'string' ? value.toLowerCase() : '';
  return (
    isProviderConfigErrorMessage(value) ||
    message.includes('quota') ||
    message.includes('insufficient') ||
    message.includes('credit') ||
    message.includes('403') ||
    message.includes('401')
  );
};

const hasTimeoutErrorMessage = (value: unknown): boolean => {
  const message = typeof value === 'string' ? value.toLowerCase() : '';
  return message.includes('timeout') || message.includes('timed out') || message.includes('לקחה יותר מדי זמן');
};

const toSceneChunks = (text: string): string[] => {
  const sentences = text
    .split(/\n+|(?<=[.!?！？。])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length === 0) return [];

  const targetScenes = Math.min(6, Math.max(3, Math.ceil(sentences.length / 2)));
  const chunkSize = Math.max(1, Math.ceil(sentences.length / targetScenes));
  const chunks: string[] = [];

  for (let i = 0; i < sentences.length && chunks.length < 6; i += chunkSize) {
    chunks.push(sentences.slice(i, i + chunkSize).join(' '));
  }

  return chunks;
};

const buildFallbackScenesFromText = (sourceText: string, style: string, targetSec?: number): ScriptScene[] => {
  const chunks = toSceneChunks(sourceText);
  const targetSceneCount = targetSec ? Math.max(3, Math.round(targetSec / 10)) : 3;
  const safeChunks = chunks.length > 0
    ? chunks
    : [
        'פתיחה עם הוק חד שמציג את הערך המרכזי.',
        'הצגת הפתרון והיתרונות העיקריים בצורה ברורה.',
        'סיום עם קריאה לפעולה ממוקדת וברורה.',
      ];

  const result = [...safeChunks];
  while (result.length < targetSceneCount && result.length < 60) {
    const fillers = [
      'הוכחה חברתית — ציטוט לקוח מרוצה.',
      'יתרון נוסף — מה מבדיל אותנו.',
      'שאלה נפוצה — תשובה ברורה ופשוטה.',
      'Before/After — ההבדל לפני ואחרי.',
      'קריאה לפעולה נוספת.',
    ];
    result.push(fillers[result.length % fillers.length]);
  }

  return result.slice(0, targetSceneCount).map((chunk, idx) => ({
    id: idx + 1,
    title: `סצנה ${idx + 1}`,
    speaker: 'קריין',
    spokenText: chunk,
    visualDescription: 'סצנה קולנועית ריאליסטית עם עומק שדה, תאורה מקצועית ותנועה טבעית בפריים.',
    subtitleText: chunk.slice(0, 64),
    icons: ['🎬', '✨'],
    duration: 10,
    transition: 'fade',
    cameraDirection: 'Wide shot עם Dolly-in איטי למוקד',
    environment: 'סביבה מקצועית רלוונטית לתוכן הסרטון',
    characters: 'דמות מרכזית ודמויות משנה רלוונטיות',
    videoStyle: style || 'cinematic',
    backgroundAction: 'ברקע יש תנועה טבעית של אנשים/אלמנטים סביבתיים שמוסיפה חיים לסצנה.',
  }));
};

export function VideoWizardFlow({
  avatars, voices, activeBrand, activeBrandId,
  buildPrompt, initialCategory, brandDepartments,
  onBack, onClose, restoredSession, onSessionChange,
}: VideoWizardFlowProps) {
  // Step: 0=prompt, 1=script review, 2=media+settings, 3=generating, 4=result
  const [step, setStep] = useState(restoredSession?.step ?? 0);
  const [prompt, setPrompt] = useState(restoredSession?.prompt ?? '');
  const [loading, setLoading] = useState(false);

  // Video type + duration
  const [videoType, setVideoType] = useState<VideoType>(restoredSession?.videoType ?? 'marketing');
  const [targetDurationSec, setTargetDurationSec] = useState(restoredSession?.targetDurationSec ?? 60);

  // Multi-select avatars & voices
  const [selectedAvatarIds, setSelectedAvatarIds] = useState<string[]>(restoredSession?.selectedAvatarIds ?? []);
  const [selectedVoiceIds, setSelectedVoiceIds] = useState<string[]>(restoredSession?.selectedVoiceIds ?? []);
  const [useAiVoice, setUseAiVoice] = useState(restoredSession?.useAiVoice ?? false);
  const [videoStyle, setVideoStyle] = useState<string>(restoredSession?.videoStyle ?? 'cinematic');

  // Voice preview
  const [previewingVoice, setPreviewingVoice] = useState(false);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [showVoicePreviewCost, setShowVoicePreviewCost] = useState(false);

  // Script
  const [generatedScript, setGeneratedScript] = useState<GeneratedScript | null>(restoredSession?.generatedScript ?? null);
  const [editingSceneIdx, setEditingSceneIdx] = useState<number | null>(null);

  // Media
  const [uploadedImages, setUploadedImages] = useState<string[]>(restoredSession?.uploadedImages ?? []);
  const MAX_IMAGES = 7;

  // Result
  const [resultVideoUrl, setResultVideoUrl] = useState<string | null>(restoredSession?.resultVideoUrl ?? null);
  const [runwayPolling, setRunwayPolling] = useState(false);
  const [runwayProgress, setRunwayProgress] = useState(0);
  const [progressStage, setProgressStage] = useState('');

  // Improve / refine
  const [improvePrompt, setImprovePrompt] = useState(restoredSession?.improvePrompt ?? '');
  const [isImproving, setIsImproving] = useState(false);

  // Save
  const [savingOutput, setSavingOutput] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(restoredSession?.selectedCategory ?? initialCategory ?? '');
  const [customCategory, setCustomCategory] = useState(restoredSession?.customCategory ?? '');
  const effectiveCategory = customCategory.trim() || selectedCategory;

  // Speech
  const { isListening, isSupported: speechSupported, toggle: toggleSpeech } = useSpeechToText({
    language: 'he-IL',
    onResult: (text) => setPrompt(prev => prev ? `${prev} ${text}` : text),
  });

  // Website scraping
  const [websiteUrl, setWebsiteUrl] = useState(restoredSession?.websiteUrl ?? '');
  const [websiteData, setWebsiteData] = useState<WebsiteScrapeResult | null>(null);
  const [scrapingWebsite, setScrapingWebsite] = useState(false);

  // Reliability/observability
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [debugLogs, setDebugLogs] = useState<GenerationDebugLog[]>([]);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [dryRunMode, setDryRunMode] = useState(false);
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);

  // Cost approval gate
  const [showCostApproval, setShowCostApproval] = useState(false);
  const [costEstimates, setCostEstimates] = useState<CostEstimate[]>([]);
  const [pendingAction, setPendingAction] = useState<'generate' | 'improve' | null>(null);

  // Emit session changes to parent for persistence
  useEffect(() => {
    if (!onSessionChange) return;
    // Don't save while generating (step 3) — transient state
    if (step === 3 || loading) return;
    const session: VideoWizardSession = {
      step, prompt, selectedAvatarIds, selectedVoiceIds, useAiVoice, videoStyle,
      generatedScript, uploadedImages, resultVideoUrl, selectedCategory, customCategory,
      websiteUrl, improvePrompt, videoType, targetDurationSec,
    };
    onSessionChange(session);
  }, [step, prompt, selectedAvatarIds, selectedVoiceIds, useAiVoice, videoStyle,
      generatedScript, uploadedImages, resultVideoUrl, selectedCategory, customCategory,
      websiteUrl, improvePrompt, loading, videoType, targetDurationSec]);

  const handleScrapeWebsite = async () => {
    if (!websiteUrl.trim()) return;
    setScrapingWebsite(true);
    try {
      const result = await websiteScraperService.scrape(websiteUrl.trim());
      setWebsiteData(result);
      toast.success('האתר נסרק בהצלחה! המידע ישולב בסרטון');
      
      const newImages: string[] = [];
      
      // Add screenshot as usable image for video scenes
      const screenshotUrl = websiteScraperService.getScreenshotUrl(result);
      if (screenshotUrl && !uploadedImages.includes(screenshotUrl)) {
        newImages.push(screenshotUrl);
      }
      
      // Add logo if available
      if (result.branding?.logo && !uploadedImages.includes(result.branding.logo) && result.branding.logo !== screenshotUrl) {
        newImages.push(result.branding.logo);
      }
      
      if (newImages.length > 0) {
        setUploadedImages(prev => [...newImages, ...prev].slice(0, MAX_IMAGES));
        toast.info(`נוספו ${newImages.length} תמונות מהאתר (צילום מסך${result.branding?.logo ? ' + לוגו' : ''})`);
      }
    } catch (e: any) {
      toast.error(e.message || 'שגיאה בסריקת האתר');
    } finally {
      setScrapingWebsite(false);
    }
  };

  const selectedAvatars = avatars.filter(a => selectedAvatarIds.includes(a.id));
  const eligibleVoices = voices.filter(v => Boolean(v.provider_voice_id && v.is_verified));
  const selectedVoices = eligibleVoices.filter(v => selectedVoiceIds.includes(v.id));

  useEffect(() => {
    const eligibleIds = new Set(eligibleVoices.map((v) => v.id));
    setSelectedVoiceIds((prev) => {
      const filtered = prev.filter((id) => eligibleIds.has(id));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [eligibleVoices]);

  const toggleAvatar = (id: string) => {
    setSelectedAvatarIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const toggleVoice = (id: string) => {
    const voice = voices.find((v) => v.id === id);
    if (!voice?.provider_voice_id || !voice?.is_verified) {
      toast.error('הקול לא מאומת עדיין. בצע איפוס/שכפול ואימות בדף הקולות.');
      return;
    }

    setSelectedVoiceIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  // ===== Step 0: Prompt + Avatar/Voice selection =====
  const handleGenerateScript = async () => {
    if (!prompt.trim()) { toast.error('יש להזין תיאור לסרטון'); return; }
    setLoading(true);
    try {
      // Build website context for the script generator
      let websiteContext: string | undefined;
      if (websiteData) {
        const parts: string[] = [];
        if (websiteData.metadata?.title) parts.push(`כותרת האתר: ${websiteData.metadata.title}`);
        if (websiteData.metadata?.description) parts.push(`תיאור האתר: ${websiteData.metadata.description}`);
        if (websiteData.branding?.colors) {
          const colorList = Object.entries(websiteData.branding.colors).map(([k, v]) => `${k}: ${v}`).join(', ');
          parts.push(`צבעי המותג מהאתר: ${colorList}`);
        }
        if (websiteData.branding?.fonts?.length) {
          parts.push(`פונטים באתר: ${websiteData.branding.fonts.map(f => f.family).join(', ')}`);
        }
        // Include first 800 chars of markdown as content summary
        if (websiteData.markdown) {
          parts.push(`תוכן האתר (תקציר):\n${websiteData.markdown.slice(0, 800)}`);
        }
        // Include key links from the website
        if (websiteData.links?.length) {
          const keyLinks = websiteData.links
            .filter(l => !l.includes('#') && !l.includes('javascript:'))
            .slice(0, 10);
          if (keyLinks.length > 0) {
            parts.push(`דפים עיקריים באתר:\n${keyLinks.join('\n')}`);
          }
        }
        // Note screenshot availability
        const hasScreenshotImg = !!websiteScraperService.getScreenshotUrl(websiteData);
        if (hasScreenshotImg) {
          parts.push('יש צילום מסך איכותי של האתר שנוסף כתמונה — חובה לשלב סצנה שמציגה את האתר על מסך מחשב/טלפון עם גלילה/אינטראקציה.');
        }
        websiteContext = parts.join('\n');
      }

      const { data, error } = await supabase.functions.invoke('generate-script', {
        body: {
          prompt: buildPrompt(prompt),
          avatarNames: selectedAvatars.map(a => a.name),
          voiceNames: selectedVoices.map(v => v.name),
          brandContext: activeBrand ? `${activeBrand.name} — ${activeBrand.industry || ''} — טון: ${activeBrand.tone || ''}` : undefined,
          hasImages: uploadedImages.length > 0,
          videoStyle,
          websiteUrl: websiteUrl.trim() || undefined,
          websiteContext,
          hasScreenshot: !!websiteData?.screenshot,
          targetDurationSec,
          videoType,
        },
      });
      if (error) throw new Error(error.message || 'שגיאה ביצירת תסריט');
      if (data?.error) throw new Error(data.error);
      setGeneratedScript(data);
      setStep(1);
      toast.success('התסריט נוצר!');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const normalizeAvatarForVideo = async (avatarUrl: string): Promise<string> => {
    const ensureUpload = async (blob: Blob, forceJpg = false) => {
      const fileType = forceJpg ? 'image/jpeg' : (blob.type || 'image/png');
      const ext = fileType.includes('jpeg') ? 'jpg' : 'png';
      const file = new File([blob], `avatar-source-${Date.now()}.${ext}`, { type: fileType });
      return storageService.upload(file);
    };

    if (avatarUrl.startsWith('data:image/')) {
      const res = await fetch(avatarUrl);
      const blob = await res.blob();
      return ensureUpload(blob, true);
    }

    if (!/\.(png|jpe?g)(\?|$)/i.test(avatarUrl)) {
      const res = await fetch(avatarUrl);
      const blob = await res.blob();
      return ensureUpload(blob, true);
    }

    return avatarUrl;
  };

  const waitForHeygenResult = async (videoId: string, onProgress: (p: number) => void): Promise<string> => {
    for (let attempts = 1; attempts <= HEYGEN_MAX_POLL_ATTEMPTS; attempts++) {
      const status = await heygenService.checkStatus(videoId);
      if (status.status === 'done' && status.videoUrl) return status.videoUrl;
      if (status.status === 'error' || status.status === 'failed') throw new Error('שגיאה ביצירת סרטון אווטאר');
      onProgress(Math.min(95, attempts * 1.2));
      await sleep(RUNWAY_STATUS_POLL_MS);
    }
    throw new Error('תם הזמן להמתנה לתוצאת אווטאר');
  };

  const waitForRunwayResult = async (taskId: string, onProgress: (p: number) => void): Promise<string> => {
    for (let attempts = 1; attempts <= RUNWAY_MAX_POLL_ATTEMPTS; attempts++) {
      const status = await runwayService.checkStatus(taskId);
      const rawProgress = typeof status.progress === 'number' ? status.progress : 0;
      const normalizedProgress = rawProgress <= 1 ? rawProgress * 100 : rawProgress;
      onProgress(Math.max(5, Math.min(95, normalizedProgress)));

      if (status.status === 'SUCCEEDED' && status.resultUrl) return status.resultUrl;
      if (status.status === 'FAILED') throw new Error(status.failureReason || 'שגיאה ביצירת סרטון');

      await sleep(RUNWAY_STATUS_POLL_MS);
    }

    throw new Error('תם הזמן להמתנה לסצנה מ-Runway');
  };

  // Build prompt for a specific scene — maximize detail for Runway AI
  const buildRunwayPromptForScene = (scene: ScriptScene): string => {
    const parts: string[] = [];
    
    // Style directive first — sets the visual tone
    const styleLabel = scene.videoStyle || videoStyle || 'cinematic';
    const styleDirectives: Record<string, string> = {
      cinematic: 'Photorealistic cinematic film shot on RED camera, professional Hollywood lighting, shallow depth of field, 8K quality, anamorphic lens flares',
      disney: 'High-quality 3D Pixar DreamWorks animation style, detailed character rendering with subsurface scattering on skin, volumetric lighting with visible light rays, rich saturated color palette, expressive cartoon characters with big emotional eyes, hyper-detailed environment textures, global illumination, cinematic camera angles',
      anime: 'Premium anime style inspired by Makoto Shinkai and Studio Ghibli, detailed linework, dramatic volumetric lighting with god rays, dynamic composition with speed lines, vivid sky gradients',
      cartoon: 'Colorful stylized cartoon illustration, bold outlines, exaggerated expressions, playful composition, vibrant flat colors with subtle shading',
      documentary: 'Documentary style, natural ambient lighting, handheld camera feel with slight motion, authentic raw footage look, bokeh background',
      commercial: 'Ultra high-end TV commercial, perfect studio lighting, pristine product photography, smooth dolly camera movement, flawless color grading',
    };
    parts.push(styleDirectives[styleLabel] || styleDirectives.cinematic);
    
    // Camera direction — how the shot is framed  
    if (scene.cameraDirection) parts.push(scene.cameraDirection);
    
    // Main visual — the core of what the AI sees
    if (scene.visualDescription) parts.push(scene.visualDescription);
    
    // Characters — who is in the frame (critical for consistency)
    if (scene.characters) parts.push(scene.characters);
    
    // Environment — where it happens
    if (scene.environment) parts.push(scene.environment);
    
    // Background action — dynamic life in the background
    if (scene.backgroundAction) parts.push(scene.backgroundAction);
    
    // Quality boosters for animation styles
    if (styleLabel === 'disney') {
      parts.push('Octane render quality, ray tracing, ambient occlusion, motion blur on fast movements, particle effects (dust, sparkles, light motes floating in air)');
    }
    
    // Brand context
    if (activeBrand?.name) parts.push(`Brand: ${activeBrand.name}`);
    
    return toRunwayPrompt(parts.join('. '));
  };

  // ===== Shared scene generation helpers (used by generate + improve) =====
  const createHeygenSceneClipShared = async (
    sceneText: string, sceneIdx: number, audioUrl: string | undefined,
    normalizedAvatarUrl: string | null, onProgress: (p: number) => void
  ): Promise<string> => {
    const createFromPhoto = async (photoUrl: string, includeAudio: boolean): Promise<string> => {
      const result = await heygenExtendedService.createPhotoAvatarVideo(
        photoUrl, sceneText, undefined, includeAudio ? audioUrl : undefined,
      );
      if (!result?.videoId) throw new Error('HeyGen לא החזיר מזהה וידאו');
      return waitForHeygenResult(result.videoId, onProgress);
    };

    const primaryPhotoUrl = normalizedAvatarUrl || (await (async () => {
      const { data: imgData } = await supabase.functions.invoke('generate-image', {
        body: { prompt: 'Professional presenter headshot, studio lighting, looking at camera, neutral background' },
      });
      return imgData?.imageUrl as string | undefined;
    })());

    if (!primaryPhotoUrl) throw new Error('אין תמונת אווטאר זמינה עבור HeyGen');

    try {
      return await createFromPhoto(primaryPhotoUrl, Boolean(audioUrl));
    } catch (firstErr) {
      if (!audioUrl) throw firstErr;
      return createFromPhoto(primaryPhotoUrl, false);
    }
  };

  const createAIImageToVideoClipShared = async (
    scenePrompt: string, _sceneIdx: number, sceneDuration: number, onProgress: (p: number) => void
  ): Promise<string> => {
    onProgress(5);
    const imagePrompt = `Ultra high quality cinematic still frame, 8K resolution, professional photography. ${scenePrompt}. Photorealistic, dramatic lighting, shallow depth of field, movie-quality composition. NO text, NO watermarks, NO UI elements.`;
    const { data: imgData, error: imgError } = await supabase.functions.invoke('generate-image', {
      body: { prompt: imagePrompt },
    });
    if (imgError || !imgData?.imageUrl) throw new Error('AI image generation failed');
    onProgress(40);
    try {
      // kling-2.5 = image-to-video (animates the generated image)
      const kreaStart = await kreaService.generateVideo(scenePrompt, {
        model: 'kling-2.5', width: 1280, height: 720,
        duration: Math.max(8, Math.min(10, sceneDuration)),
        imageUrl: imgData.imageUrl,
      });
      if (kreaStart?.jobId) {
        const pollStart = Date.now();
        while (Date.now() - pollStart < 180000) {
          await sleep(5000);
          const status = await kreaService.checkStatus(kreaStart.jobId);
          if (status?.videoUrl) { onProgress(100); return status.videoUrl; }
          if (status?.status === 'failed') throw new Error('Krea animation failed: ' + (status?.error || 'unknown'));
          onProgress(40 + Math.min(55, ((Date.now() - pollStart) / 300000) * 55));
        }
        throw new Error('Krea animation timeout after 3 minutes');
      }
    } catch (kreaAnimErr) {
      console.warn('Krea animation failed, using still image as clip:', kreaAnimErr);
    }
    onProgress(100);
    return imgData.imageUrl;
  };

  const createKreaSceneClipShared = async (
    scenePrompt: string, _sceneIdx: number, sceneDuration: number, onProgress: (p: number) => void,
    imageUrlOverride?: string | null
  ): Promise<string> => {
    onProgress(5);
    // Smart model selection: kling-2.5 for image-to-video, veo-3 for text-to-video
    const kreaImageUrl = imageUrlOverride ?? uploadedImages[0] ?? undefined;
    const kreaModel = kreaImageUrl ? 'kling-2.5' : 'veo-3';
    const kreaStart = await kreaService.generateVideo(scenePrompt, {
      model: kreaModel, width: 1280, height: 720,
      duration: Math.max(8, Math.min(10, sceneDuration)),
      imageUrl: kreaImageUrl,
    });
    if (!kreaStart?.jobId) throw new Error('Krea video start failed - no jobId returned');
    const jobId = kreaStart.jobId;
    const pollStart = Date.now();
    while (Date.now() - pollStart < 180000) {
      await sleep(5000);
      const status = await kreaService.checkStatus(jobId);
      if (status?.videoUrl) { onProgress(100); return status.videoUrl; }
      if (status?.status === 'failed') throw new Error('Krea video failed: ' + (status?.error || 'unknown'));
      onProgress(10 + Math.min(85, ((Date.now() - pollStart) / 300000) * 85));
    }
    throw new Error('Krea video timeout after 3 minutes');
  };

  // ===== Debug log helper =====
  const addDebugLog = (runId: string, step: string, status: DebugLogStatus, message: string, meta?: Record<string, unknown>) => {
    const entry: GenerationDebugLog = { timestamp: new Date().toISOString(), runId, step, status, message, meta };
    setDebugLogs(prev => [...prev, entry]);
    if (status === 'error') console.error(`[${runId}] ${step}: ${message}`, meta);
    else console.log(`[${runId}] ${step}: ${message}`);
  };

  // ===== Preflight validation =====
  const runPreflight = async (): Promise<PreflightResult> => {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const errors: string[] = [];
    const warnings: string[] = [];
    const health: ProviderHealth = { runway: 'unavailable', heygen: 'unavailable', krea: 'unavailable', compose: 'unavailable', credits: 'unavailable' };

    // Validate required fields
    if (!generatedScript) errors.push('אין תסריט');
    const scenes = generatedScript?.scenes || [];
    if (scenes.length === 0) warnings.push('אין סצנות בתסריט — ייווצרו אוטומטית');
    if (!prompt.trim()) warnings.push('אין פרומפט מקורי');

    // Check provider health in parallel
    try {
      const [heygenRes, creditsRes] = await Promise.allSettled([
        withTimeout(supabase.functions.invoke('heygen-video', { body: { action: 'health_check' } }), 8000, 'HeyGen timeout'),
        withTimeout(supabase.functions.invoke('check-credits', { body: {} }), 25000, 'Credits timeout'),
      ]);
      if (creditsRes.status === 'fulfilled') {
        health.credits = 'healthy';
        const items = (creditsRes.value?.data as any)?.credits || [];
        for (const c of items) {
          if (c.service === 'runway' && c.canGenerate) health.runway = 'healthy';
          if (c.service === 'krea' && c.canGenerate) health.krea = 'healthy';
          // Use check-credits as primary HeyGen source (more reliable than health_check)
          if (c.service === 'heygen') {
            if (c.canGenerate) health.heygen = 'healthy';
            else if (c.readiness !== 'auth_failed') health.heygen = 'degraded';
            else health.heygen = 'unavailable';
          }
        }
      }
      // Fallback: if heygen not in credits (key not configured), use health_check result
      if (health.heygen === 'unavailable') {
        if (heygenRes.status === 'fulfilled' && heygenRes.value?.data?.ok) health.heygen = 'healthy';
        else health.heygen = 'degraded';
      }
      // If credits check timed out, show degraded (not X) for unchecked providers
      if (creditsRes.status !== 'fulfilled') {
        if (health.krea === 'unavailable') health.krea = 'degraded';
        if (health.runway === 'unavailable') health.runway = 'degraded';
        if (health.credits === 'unavailable') health.credits = 'degraded';
      }
      // Shotstack is always available if key exists
      health.compose = 'healthy';
    } catch { /* partial health is fine */ }

    if (health.runway === 'unavailable' && health.heygen === 'unavailable' && health.krea === 'unavailable') {
      errors.push('אף ספק וידאו לא זמין');
    }

    // Validate media references
    if (selectedAvatars[0]?.image_url) {
      try {
        const res = await fetch(selectedAvatars[0].image_url, { method: 'HEAD' });
        if (!res.ok) warnings.push('קישור לתמונת אווטאר לא נגיש');
      } catch { warnings.push('לא ניתן לבדוק קישור אווטאר'); }
    }

    const payloadPreview: Record<string, unknown> = {
      scenes: scenes.length,
      avatars: selectedAvatars.map(a => a.name),
      voices: selectedVoices.map(v => v.name),
      videoStyle,
      promptLength: prompt.length,
      imagesCount: uploadedImages.length,
    };

    return { ok: errors.length === 0, runId, checkedAt: new Date().toISOString(), errors, warnings, providerHealth: health, payloadPreview };
  };

  // Cost approval gate for video generation
  const requestGenerateVideo = () => {
    if (!generatedScript) return;
    if (dryRunMode) {
      // Dry run doesn't cost credits — proceed directly
      handleGenerateVideo();
      return;
    }
    const sceneCount = generatedScript.scenes?.length || 3;
    const hasVoice = selectedVoices.length > 0 || useAiVoice;
    const hasAvatar = selectedAvatars.length > 0;
    setCostEstimates(buildVideoGenerationEstimates(sceneCount, hasVoice, hasAvatar));
    setPendingAction('generate');
    setShowCostApproval(true);
  };

  const requestImproveVideo = () => {
    if (!improvePrompt.trim()) { toast.error('תאר מה לשפר בסרטון'); return; }
    const sceneCount = generatedScript?.scenes?.length || 3;
    const hasVoice = selectedVoices.length > 0 || useAiVoice;
    const hasAvatar = selectedAvatars.length > 0;
    setCostEstimates(buildVideoGenerationEstimates(sceneCount, hasVoice, hasAvatar));
    setPendingAction('improve');
    setShowCostApproval(true);
  };

  const handleCostApproved = () => {
    setShowCostApproval(false);
    if (pendingAction === 'generate') handleGenerateVideo();
    else if (pendingAction === 'improve') handleImproveVideo();
    setPendingAction(null);
  };

  // ===== Step 3: Generate video (full pipeline) =====
  const handleGenerateVideo = async () => {
    if (!generatedScript) return;

    // Run preflight
    const preflight = await runPreflight();
    setPreflightResult(preflight);
    const runId = preflight.runId;
    setActiveRunId(runId);
    setDebugLogs([]);
    addDebugLog(runId, 'preflight', preflight.ok ? 'success' : 'error', preflight.ok ? 'Preflight passed' : `Preflight failed: ${preflight.errors.join(', ')}`, { health: preflight.providerHealth, warnings: preflight.warnings });

    if (dryRunMode) {
      toast.info('מצב בדיקה מוקדמת — לא מתבצעת יצירה. בדוק את הלוג בפאנל הדיבאג.');
      setShowDebugPanel(true);
      return;
    }

    if (!preflight.ok) {
      toast.error(`לא ניתן להתחיל: ${preflight.errors.join(', ')}`);
      return;
    }

    setLoading(true);
    setStep(3);
    setRunwayPolling(true);
    setRunwayProgress(0);
    setProgressStage('מכין את הייצור...');

    try {
      const avatarImage = selectedAvatars[0]?.image_url;
      const workingScenes = generatedScript.scenes.length > 0
        ? generatedScript.scenes
        : buildFallbackScenesFromText(generatedScript.script || prompt, videoStyle, targetDurationSec);

      if (generatedScript.scenes.length === 0) {
        toast.info('התסריט הגיע בלי סצנות; יצרתי סצנות אוטומטיות כדי למנוע נפילה.');
      }

      const fullScript = workingScenes.map((s) => s.spokenText).join(' ');
      const narrationText = toNarrationText(fullScript);
      const selectedVoice = selectedVoices[0];
      let narrationAudioUrl: string | undefined;
      const sceneErrors: string[] = [];
      const totalScenes = workingScenes.length;
      const sceneResults: Array<{ url: string; scene: ScriptScene } | null> = Array(totalScenes).fill(null);
      const failedSceneIndexes: number[] = [];

      let forceDidOnlyMode = false;
      let forceKreaOnlyMode = false;
      let heygenFallbackEnabled = true;
      let kreaFallbackEnabled = true;
      let runwayFallbackEnabled = false; // blocked by default — only enabled if credit check confirms

      setProgressStage('בודק זמינות ספקים וקרדיטים...');
      setRunwayProgress(2);

      try {
        const { data: creditsData } = await withTimeout(
          supabase.functions.invoke('check-credits', { body: {} }),
          CREDITS_CHECK_TIMEOUT_MS,
          'בדיקת הקרדיטים לקחה יותר מדי זמן'
        );

        const creditItems = Array.isArray((creditsData as any)?.credits) ? (creditsData as any).credits : [];
        const creditsMap = Object.fromEntries(
          creditItems
            .filter((c: any) => typeof c?.service === 'string')
            .map((c: any) => [c.service, c])
        ) as Record<string, { canGenerate?: boolean; readiness?: string; error?: string; statusLabel?: string }>;

        // Use granular readiness levels instead of binary canGenerate
        const isGenerationReady = (svc: string) => {
          const s = creditsMap[svc];
          if (!s) return true; // not configured = assume available
          const r = s.readiness;
          // Only allow providers verified at credits_ok or generation_verified level
          return r === 'generation_verified' || r === 'credits_ok';
        };

        const isBlocked = (svc: string) => {
          const s = creditsMap[svc];
          if (!s) return false;
          return s.readiness === 'blocked_credits' || s.readiness === 'auth_failed';
        };

        const getStatusLabel = (svc: string) => creditsMap[svc]?.statusLabel || '';

        const runwayReady = isGenerationReady('runway');
        const heygenReady = isGenerationReady('heygen');
        const kreaReady = isGenerationReady('krea');
        const runwayBlocked = isBlocked('runway');
        const heygenBlocked = isBlocked('heygen');
        const kreaBlocked = isBlocked('krea');

        heygenFallbackEnabled = heygenReady;
        kreaFallbackEnabled = kreaReady;
        runwayFallbackEnabled = runwayReady && !runwayBlocked;

        // Smart avatar routing — applied AFTER credits check so it takes final priority
        const avatarStyle = (selectedAvatars[0]?.style || '').toLowerCase();
        const isCartoonAvatar = /disney|cartoon|anime|manga|illustra|קריקט|אנימ|דיסנ|רישום|ציור|תלת.מימד|3d/.test(avatarStyle);
        if (isCartoonAvatar && avatarImage) {
          // Cartoon/illustration avatar → HeyGen requires real face, skip it
          heygenFallbackEnabled = false;
          addDebugLog(runId, 'avatar-routing', 'info', 'Cartoon avatar detected — skipping HeyGen, using Krea image-to-video', { avatarStyle });
        }
        if (!avatarImage) {
          // No avatar → pure cinematic veo-3 (text-to-video, no talking head)
          heygenFallbackEnabled = false;
          addDebugLog(runId, 'avatar-routing', 'info', 'No avatar selected — cinematic veo-3 mode');
        }

        addDebugLog(runId, 'provider-routing', 'info',
          `Readiness: Runway=${creditsMap.runway?.readiness || 'N/A'} | HeyGen=${creditsMap.heygen?.readiness || 'N/A'} | Krea=${creditsMap.krea?.readiness || 'N/A'}`,
          { runway: creditsMap.runway?.statusLabel, heygen: creditsMap.heygen?.statusLabel, krea: creditsMap.krea?.statusLabel }
        );

        if (runwayBlocked || !runwayReady) {
          if (heygenReady) {
            forceDidOnlyMode = true;
            toast.warning(`Runway: ${getStatusLabel('runway') || 'לא זמין'} — עובר אוטומטית למסלול HeyGen.`);
          } else if (kreaReady) {
            forceKreaOnlyMode = true;
            toast.warning(`Runway: ${getStatusLabel('runway') || 'לא זמין'} — עובר למסלול Krea.`);
          } else if (runwayBlocked && heygenBlocked && kreaBlocked) {
            throw new Error(`כל ספקי הווידאו חסומים:\n• Runway: ${getStatusLabel('runway')}\n• HeyGen: ${getStatusLabel('heygen')}\n• Krea: ${getStatusLabel('krea')}\nיש לחדש קרדיטים ואז לנסות שוב.`);
          } else {
            // Providers are "authenticated" but not verified — try anyway with warning
            toast.warning('הספקים מחוברים אבל היצירה לא אומתה — מנסה עם מנגנון גיבוי אוטומטי.');
          }
        }
      } catch (creditsErr: any) {
        const msg = creditsErr?.message || '';
        if (msg.includes('חסומים') || msg.includes('אין קרדיטים')) throw creditsErr;
        console.warn('Credit check skipped:', msg);
        toast.info('בדיקת הספקים מתעכבת, ממשיכים לייצור עם מנגנון גיבוי אוטומטי.');
      }

      // Narration is ALWAYS generated for explainer/marketing/episode videos.
      // forceDidOnlyMode only changes video provider routing, NOT narration.
      const shouldGenerateNarration = true;

      // === Stage 1: generate narration (skip in forced D-ID mode) ===
      setProgressStage(shouldGenerateNarration ? 'מייצר קריינות בעברית...' : 'מכין מסלול אווטאר חלופי...');
      setRunwayProgress(5);

      addDebugLog(runId, 'narration', 'info', `Generating narration: voice=${selectedVoice?.name || 'AI'}, textLen=${narrationText.length}`);

      if (shouldGenerateNarration && selectedVoice?.audio_url && narrationText) {
        try {
          const preferredModel = selectedVoice.verification_selected_model || 'eleven_v3';
          const cloneResult = await voiceCloneService.cloneAndSpeak({
            providerVoiceId: selectedVoice.provider_voice_id || undefined,
            audioUrl: selectedVoice.provider_voice_id ? undefined : selectedVoice.audio_url,
            scriptText: narrationText,
            language: 'he',
            modelId: preferredModel,
            omitLanguageCode: preferredModel === 'eleven_multilingual_v2',
          });
          narrationAudioUrl = cloneResult.audioUrl;
          addDebugLog(runId, 'narration', 'success', 'Voice clone + TTS succeeded', { audioUrl: narrationAudioUrl });
          toast.success('הקריינות בקול שלך מוכנה!');
        } catch (cloneErr: any) {
          const msg = cloneErr?.message || '';
          addDebugLog(runId, 'narration', 'warn', `Voice clone failed: ${msg}`);
          console.warn('Voice clone failed, falling back to AI TTS:', msg);
          if (msg.includes('קובץ הקול לא נמצא')) {
            toast.error('קובץ הדגימה של הקול השמור לא נמצא. העלה/הקלט קול מחדש, בינתיים ממשיך עם קריין AI.');
            setSelectedVoiceIds(prev => prev.filter(id => id !== selectedVoice.id));
          } else {
            toast.info('לא הצלחתי לשכפל את הקול, משתמש בקריין AI...');
          }
        }
      }

      if (shouldGenerateNarration && !narrationAudioUrl && narrationText) {
        try {
          narrationAudioUrl = await voiceService.generateAndUpload(narrationText);
          addDebugLog(runId, 'narration', 'success', 'AI TTS succeeded', { audioUrl: narrationAudioUrl });
          toast.success('קריינות AI בעברית מוכנה!');
        } catch (ttsErr: any) {
          addDebugLog(runId, 'narration', 'error', `AI TTS failed: ${ttsErr?.message}`);
          // FAIL-FAST: Do NOT continue without narration
          throw new Error(`קריינות נכשלה (text-to-speech): ${ttsErr?.message || 'שגיאה לא ידועה'}. לא ניתן להמשיך ללא קריינות.`);
        }
      }

      // FAIL-FAST: If narration was expected but missing, stop
      if (shouldGenerateNarration && narrationText && !narrationAudioUrl) {
        throw new Error('לא הצלחתי ליצור קריינות. אין אפשרות להמשיך ללא קול — בדוק את הגדרות הקול.');
      }
      setRunwayProgress(15);

      // === Stage 2: Generate video clips — one per scene ===
      const progressPerScene = totalScenes > 0 ? 50 / totalScenes : 50;
      const updateSceneProgress = (sceneIdx: number, progress: number) => {
        setRunwayProgress(15 + sceneIdx * progressPerScene + (progress / 100) * progressPerScene);
      };

      const normalizedAvatarUrl = avatarImage ? await normalizeAvatarForVideo(avatarImage) : null;

      // Wrap shared helpers with local progress tracking
      const createHeygenSceneClip = (sceneText: string, sceneIdx: number, audioUrl?: string) =>
        createHeygenSceneClipShared(sceneText, sceneIdx, audioUrl, normalizedAvatarUrl, (p) => updateSceneProgress(sceneIdx, p));

      const createAIImageToVideoClip = (scenePrompt: string, sceneIdx: number, sceneDuration: number) =>
        createAIImageToVideoClipShared(scenePrompt, sceneIdx, sceneDuration, (p) => updateSceneProgress(sceneIdx, p));

      const createKreaSceneClip = (scenePrompt: string, sceneIdx: number, sceneDuration: number) =>
        createKreaSceneClipShared(scenePrompt, sceneIdx, sceneDuration, (p) => updateSceneProgress(sceneIdx, p), normalizedAvatarUrl ?? uploadedImages[0]);

      // Runway starts blocked; only unblocked if credit check confirmed it's ready.
      // This ensures no Runway calls if credit check times out or fails.
      let runwayBlocked = !runwayFallbackEnabled;

      // Universal fallback function — tries all available providers in order
      // Order: HeyGen (primary) → Krea → Runway (fallback only) → AI Image (last resort)
      const generateSceneWithFallbacks = async (
        scene: ScriptScene, sceneIdx: number, sceneDuration: number, scenePrompt: string
      ): Promise<string> => {
        const errors: string[] = [];

        // Provider 1: HeyGen (primary avatar-based video)
        if (heygenFallbackEnabled) {
          try {
            setProgressStage(`סצנה ${sceneIdx + 1}: מייצר עם HeyGen...`);
            return await withTimeout(
              createHeygenSceneClip(scene.spokenText || scene.title, sceneIdx, narrationAudioUrl),
              HEYGEN_GENERATION_TIMEOUT_MS, 'HeyGen timeout'
            );
          } catch (heygenErr: any) {
            const msg = heygenErr?.message || '';
            errors.push(`HeyGen: ${msg}`);
            console.warn(`Scene ${sceneIdx + 1} HeyGen failed:`, msg);
            if (isHeygenUnavailableErrorMessage(msg) || hasTimeoutErrorMessage(msg)) {
              heygenFallbackEnabled = false;
            }
          }
        }

        // Provider 2: Krea (direct video generation)
        if (kreaFallbackEnabled) {
          try {
            setProgressStage(`סצנה ${sceneIdx + 1}: מייצר עם Krea...`);
            return await withTimeout(
              createKreaSceneClip(scenePrompt, sceneIdx, sceneDuration),
              KREA_FALLBACK_TIMEOUT_MS, 'Krea timeout'
            );
          } catch (kreaErr: any) {
            const msg = kreaErr?.message || '';
            errors.push(`Krea: ${msg}`);
            console.warn(`Scene ${sceneIdx + 1} Krea failed:`, msg);
            if (isKreaCreditsErrorMessage(msg)) {
              kreaFallbackEnabled = false;
            }
          }
        }

        // Provider 3: Runway (fallback only — not primary)
        if (!runwayBlocked) {
          try {
            setProgressStage(`סצנה ${sceneIdx + 1}: מייצר עם Runway (גיבוי)...`);
            if (normalizedAvatarUrl && sceneIdx === 0) {
              const taskData = await withTimeout(
                runwayService.imageToVideo(normalizedAvatarUrl, scenePrompt, undefined, sceneDuration),
                30000, 'Runway image-to-video timeout'
              );
              return await waitForRunwayResult(taskData.taskId, (p) => updateSceneProgress(sceneIdx, p));
            } else {
              const taskData = await withTimeout(
                runwayService.textToVideo(scenePrompt, undefined, sceneDuration),
                30000, 'Runway text-to-video timeout'
              );
              return await waitForRunwayResult(taskData.taskId, (p) => updateSceneProgress(sceneIdx, p));
            }
          } catch (runwayErr: any) {
            const msg = runwayErr?.message || '';
            errors.push(`Runway: ${msg}`);
            console.warn(`Scene ${sceneIdx + 1} Runway failed:`, msg);
            if (isRunwayCreditsErrorMessage(msg)) {
              runwayBlocked = true;
              toast.warning('Runway לא זמין, עובר לספק חלופי...');
            }
          }
        }

        // Provider 4: AI Image + Animation (last resort — always available)
        // NOTE: createAIImageToVideoClipShared has a 3-min internal Krea poll + still-image fallback.
        // Outer timeout must exceed internal timeout (180s poll + ~30s image gen = ~210s total).
        try {
          setProgressStage(`סצנה ${sceneIdx + 1}: מייצר תמונת AI + אנימציה...`);
          return await withTimeout(
            createAIImageToVideoClip(scenePrompt, sceneIdx, sceneDuration),
            260000, 'AI Image timeout'
          );
        } catch (aiErr: any) {
          errors.push(`AI Image: ${aiErr?.message || 'unknown'}`);
        }

        throw new Error(`כל הספקים נכשלו בסצנה ${sceneIdx + 1}: ${errors.join(' | ')}`);
      };

      for (let sceneIdx = 0; sceneIdx < totalScenes; sceneIdx++) {
        const scene = workingScenes[sceneIdx];
        const sceneNum = sceneIdx + 1;
        const sceneDuration = Math.max(5, Math.min(10, Number(scene.duration) || 10));
        setProgressStage(`מייצר סצנה ${sceneNum} מתוך ${totalScenes}: ${scene.title}...`);

        const scenePrompt = buildRunwayPromptForScene(scene);

        try {
          const clipUrl = await generateSceneWithFallbacks(scene, sceneIdx, sceneDuration, scenePrompt);

          sceneResults[sceneIdx] = {
            url: clipUrl,
            scene: { ...scene, duration: sceneDuration },
          };
          toast.success(`סצנה ${sceneNum} מוכנה!`);
        } catch (sceneErr: any) {
          const errMsg = sceneErr?.message || 'שגיאה לא ידועה';
          sceneErrors.push(`סצנה ${sceneNum}: ${errMsg}`);
          failedSceneIndexes.push(sceneIdx);
          console.error(`Scene ${sceneNum} all providers failed:`, errMsg);
          toast.error(`סצנה ${sceneNum} נכשלה — ${errMsg}`);
        }
      }

      // Retry failed scenes with simplified prompt using universal fallback
      if (failedSceneIndexes.length > 0) {
        setProgressStage('מנסה שוב את הסצנות שנכשלו עם פרומפט מפושט...');
        for (const sceneIdx of failedSceneIndexes) {
          if (sceneResults[sceneIdx]) continue;
          const scene = workingScenes[sceneIdx];
          const simplePrompt = toRunwayPrompt(`Cinematic professional video scene. ${scene.spokenText || scene.title}`);

          try {
            const retryUrl = await generateSceneWithFallbacks(scene, sceneIdx, 10, simplePrompt);
            sceneResults[sceneIdx] = {
              url: retryUrl,
              scene: { ...scene, duration: 10 },
            };
            toast.success(`סצנה ${sceneIdx + 1} הושלמה בניסיון נוסף`);
          } catch (retryErr: any) {
            sceneErrors.push(`סצנה ${sceneIdx + 1} (ניסיון נוסף): ${retryErr?.message || 'שגיאה'}`);
          }
        }
      }

      const successfulResults = sceneResults.filter((r): r is NonNullable<typeof r> => r !== null);
      addDebugLog(runId, 'scenes', successfulResults.length > 0 ? 'success' : 'error',
        `${successfulResults.length}/${totalScenes} scenes generated`, { errors: sceneErrors });
      
      if (successfulResults.length === 0) {
        throw new Error(
          `לא הצלחתי ליצור אף סצנה. ${sceneErrors[sceneErrors.length - 1] || 'בדוק את חיבורי הספקים בהגדרות.'}`.trim()
        );
      }

      // DURATION ENFORCEMENT: Check if successful scenes can reach target duration
      const achievedDuration = successfulResults.reduce((sum, r) => sum + (Number(r.scene.duration) || 10), 0);
      const minAcceptableDuration = targetDurationSec - 2;
      const maxAcceptableDuration = targetDurationSec + 2;

      if (achievedDuration < minAcceptableDuration * 0.5) {
        // Less than half the target — fail hard
        throw new Error(`משך הסצנות שהצליחו (${achievedDuration}s) רחוק מהיעד (${targetDurationSec}s). יש לבדוק את הספקים.`);
      }

      if (successfulResults.length < sceneResults.length) {
        const missing = sceneResults.length - successfulResults.length;
        toast.warning(`${missing} סצנות לא הצליחו — ממשיך עם ${successfulResults.length} סצנות (${achievedDuration}s מתוך ${targetDurationSec}s).`);
      }

      const finalScenes = successfulResults.map((result) => result.scene);
      const sceneVideoUrls = successfulResults.map((result) => result.url);

      // === Stage 3: Composite all clips with Shotstack ===
      addDebugLog(runId, 'compose', 'info', `Starting Shotstack render with ${sceneVideoUrls.length} clips`);
      setProgressStage('מרכיב סרטון סופי — כתוביות, לוגו ואייקונים...');
      setRunwayProgress(70);

      const logoUrl = uploadedImages[0] || activeBrand?.logo || undefined;
      const brandColors = activeBrand?.colors || [];

      try {
        const renderResult = await composeService.render({
          videoUrl: sceneVideoUrls[0],
          videoUrls: sceneVideoUrls,
          scenes: finalScenes,
          logoUrl,
          brandColors,
          audioUrl: narrationAudioUrl,
        });

        addDebugLog(runId, 'compose', renderResult?.renderId ? 'success' : 'error',
          renderResult?.renderId ? `Render started: ${renderResult.renderId}` : 'No renderId returned');
        if (!renderResult?.renderId) throw new Error('Shotstack error');

        const composeMaxAttempts = Math.max(240, sceneVideoUrls.length * 120);
        setProgressStage('מעבד וידאו סופי עם כתוביות ולוגו...');

        for (let i = 0; i < composeMaxAttempts; i++) {
          const status = await composeService.checkStatus(renderResult.renderId, renderResult.shotstackEnv);
          if (status.status === 'done' && status.url) {
            const totalDuration = finalScenes.reduce((sum, scene) => sum + (Number(scene.duration) || 10), 0);

            // DURATION ENFORCEMENT: Verify output is within acceptable range
            if (totalDuration < minAcceptableDuration) {
              addDebugLog(runId, 'complete', 'warn', `Duration ${totalDuration}s below target ${targetDurationSec}s`, { outputUrl: status.url });
              toast.warning(`אזהרה: הסרטון (${totalDuration}s) קצר מהיעד (${targetDurationSec}s).`);
            }

            addDebugLog(runId, 'complete', 'success', `Video ready: ${totalDuration}s`, { outputUrl: status.url });
            setResultVideoUrl(status.url);

            // AUTO-SAVE: Save output immediately after successful render
            if (activeBrandId && activeBrand) {
              try {
                setProgressStage('שומר תוצר בפרויקט...');
                const cat = effectiveCategory || undefined;
                const project = await projectService.findOrCreateByBrand(activeBrandId, activeBrand.name, cat);
                await projectService.addOutput(project.id, {
                  name: `סרטון — ${activeBrand.name}${cat ? ` — ${cat}` : ''}`,
                  description: generatedScript?.title || prompt,
                  video_url: status.url,
                  thumbnail_url: selectedAvatars[0]?.image_url || null,
                  prompt: prompt || null,
                  script: generatedScript?.script || null,
                  provider: 'Shotstack',
                  aspect_ratio: '16:9',
                  estimated_length: `${totalDuration}s`,
                });
                addDebugLog(runId, 'save', 'success', `Output saved to project "${activeBrand.name}"`);
                toast.success(`📁 נשמר אוטומטית בפרויקט "${activeBrand.name}${cat ? ` — ${cat}` : ''}"`);
              } catch (saveErr: any) {
                addDebugLog(runId, 'save', 'error', `Auto-save failed: ${saveErr?.message}`);
                toast.error(`שגיאה בשמירה אוטומטית: ${saveErr?.message}. ניתן לשמור ידנית.`);
              }
            }

            setStep(4);
            setProgressStage('');
            toast.success(`🎬 סרטון של ${totalDuration} שניות מוכן!`);
            return;
          }
          if (status.status === 'failed') {
            addDebugLog(runId, 'compose', 'error', 'Shotstack render failed');
            throw new Error('Shotstack render failed');
          }
          setRunwayProgress(70 + (i / composeMaxAttempts) * 28);
          await sleep(COMPOSE_STATUS_POLL_MS);
        }

        throw new Error('תם הזמן להרכבת הסרטון הסופי');
      } catch (composeErr: any) {
        addDebugLog(runId, 'compose', 'error', `Shotstack compositing FAILED: ${composeErr?.message}`);
        // FAIL-FAST: Do NOT return a partial clip as success
        throw new Error(`שלב ההרכבה הסופית נכשל: ${composeErr?.message || 'שגיאה ב-Shotstack'}. לא ניתן להציג תוצר חלקי.`);
      }
    } catch (e: any) {
      toast.error(e.message || 'שגיאה ביצירת סרטון');
      setStep(2);
      setProgressStage('');
    } finally {
      setLoading(false);
      setRunwayPolling(false);
    }
  };

  // ===== Improve/Refine existing video =====
  const handleImproveVideo = async () => {
    if (!improvePrompt.trim()) { toast.error('תאר מה לשפר בסרטון'); return; }
    setIsImproving(true);
    setStep(3);
    setRunwayProgress(0);
    setProgressStage('משפר את הסרטון לפי הבקשה שלך...');

    try {
      const workingScenes = generatedScript?.scenes?.length
        ? generatedScript.scenes
        : buildFallbackScenesFromText(generatedScript?.script || prompt, videoStyle, targetDurationSec);
      const fullScript = workingScenes.map(s => s.spokenText).join(' ');
      const narrationText = toNarrationText(fullScript);
      const totalScenes = workingScenes.length;

      // Generate narration for improved video too
      let narrationAudioUrl: string | undefined;
      if (narrationText) {
        setProgressStage('מייצר קריינות בעברית...');
        try {
          const selectedVoice = selectedVoices[0];
          if (selectedVoice?.audio_url) {
            const preferredModel = selectedVoice.verification_selected_model || 'eleven_v3';
            const cloneResult = await voiceCloneService.cloneAndSpeak({
              providerVoiceId: selectedVoice.provider_voice_id || undefined,
              audioUrl: selectedVoice.provider_voice_id ? undefined : selectedVoice.audio_url,
              scriptText: narrationText,
              language: 'he',
              modelId: preferredModel,
              omitLanguageCode: preferredModel === 'eleven_multilingual_v2',
            });
            narrationAudioUrl = cloneResult.audioUrl;
          } else {
            narrationAudioUrl = await voiceService.generateAndUpload(narrationText);
          }
        } catch (cloneErr: any) {
          try {
            narrationAudioUrl = await voiceService.generateAndUpload(narrationText);
          } catch (ttsErr: any) {
            // FAIL-FAST: Do NOT continue without narration
            throw new Error(`קריינות נכשלה בשיפור: ${ttsErr?.message || cloneErr?.message || 'שגיאה לא ידועה'}`);
          }
        }
      }

      setProgressStage('מייצר סצנות משופרות...');
      const avatarImage = selectedAvatars[0]?.image_url;
      const normalizedAvatarUrl = avatarImage ? await normalizeAvatarForVideo(avatarImage) : null;
      const sceneVideoUrls: string[] = [];

      // Runway is fallback only — credit check determines availability.
      // Must run credit check first to determine which providers are available.
      let heygenFallbackEnabled = true;
      let kreaFallbackEnabled = true;
      let runwayBlocked = true; // Default blocked — only enable if credit check confirms available

      try {
        const { data: creditsData } = await withTimeout(
          supabase.functions.invoke('check-credits', { body: {} }),
          CREDITS_CHECK_TIMEOUT_MS,
          'בדיקת קרדיטים timeout'
        );
        const creditItems = Array.isArray((creditsData as any)?.credits) ? (creditsData as any).credits : [];
        for (const c of creditItems) {
          if (c.service === 'runway' && c.canGenerate && (c.readiness === 'generation_verified' || c.readiness === 'credits_ok')) runwayBlocked = false;
          if (c.service === 'heygen' && !c.canGenerate) heygenFallbackEnabled = false;
          if (c.service === 'krea' && !c.canGenerate) kreaFallbackEnabled = false;
        }
      } catch {
        // Credit check failed — keep runway blocked, allow others
      }

      for (let i = 0; i < totalScenes; i++) {
        const scene = workingScenes[i];
        setProgressStage(`משפר סצנה ${i + 1} מתוך ${totalScenes}...`);
        const improveContext = [
          improvePrompt,
          scene?.visualDescription || '',
          (scene as any)?.backgroundAction || '',
          activeBrand?.name ? `Brand: ${activeBrand.name}` : '',
        ].filter(Boolean).join('. ');

        const scenePrompt = toRunwayPrompt(improveContext);
        const sceneDuration = Math.max(5, Math.min(10, Number(scene.duration) || 10));
        const errors: string[] = [];

        let clipUrl: string | null = null;

        // Provider 1: HeyGen (primary)
        if (!clipUrl && heygenFallbackEnabled) {
          try {
            clipUrl = await withTimeout(
              createHeygenSceneClipShared(scene.spokenText || scene.title, i, narrationAudioUrl, normalizedAvatarUrl, () => {}),
              HEYGEN_GENERATION_TIMEOUT_MS, 'HeyGen timeout'
            );
          } catch (heygenErr: any) {
            errors.push(`HeyGen: ${heygenErr?.message || ''}`);
            if (isHeygenUnavailableErrorMessage(heygenErr?.message)) heygenFallbackEnabled = false;
          }
        }

        // Provider 2: Krea
        if (!clipUrl && kreaFallbackEnabled) {
          try {
            clipUrl = await withTimeout(
              createKreaSceneClipShared(scenePrompt, i, sceneDuration, () => {}, normalizedAvatarUrl ?? uploadedImages[0]),
              KREA_FALLBACK_TIMEOUT_MS, 'Krea timeout'
            );
          } catch (kreaErr: any) {
            errors.push(`Krea: ${kreaErr?.message || ''}`);
            if (isKreaCreditsErrorMessage(kreaErr?.message)) kreaFallbackEnabled = false;
          }
        }

        // Provider 3: Runway (fallback only)
        if (!clipUrl && !runwayBlocked) {
          try {
            if (normalizedAvatarUrl && i === 0) {
              const taskData = await withTimeout(
                runwayService.imageToVideo(normalizedAvatarUrl, scenePrompt, undefined, sceneDuration),
                30000, 'Runway timeout'
              );
              clipUrl = await waitForRunwayResult(taskData.taskId, (p) => setRunwayProgress(15 + (i / totalScenes) * 50 + (p / 100) * (50 / totalScenes)));
            } else {
              const taskData = await withTimeout(
                runwayService.textToVideo(scenePrompt, undefined, sceneDuration),
                30000, 'Runway timeout'
              );
              clipUrl = await waitForRunwayResult(taskData.taskId, (p) => setRunwayProgress(15 + (i / totalScenes) * 50 + (p / 100) * (50 / totalScenes)));
            }
          } catch (runwayErr: any) {
            const msg = runwayErr?.message || '';
            errors.push(`Runway: ${msg}`);
            if (isRunwayCreditsErrorMessage(msg)) runwayBlocked = true;
          }
        }

        // Provider 4: AI Image (last resort)
        if (!clipUrl) {
          try {
            clipUrl = await withTimeout(
              createAIImageToVideoClipShared(scenePrompt, i, sceneDuration, () => {}),
              260000, 'AI Image timeout'
            );
          } catch (aiErr: any) {
            errors.push(`AI Image: ${aiErr?.message || ''}`);
          }
        }

        if (clipUrl) {
          sceneVideoUrls.push(clipUrl);
        } else {
          console.error(`Improve scene ${i + 1} all providers failed:`, errors.join(' | '));
        }
      }

      if (sceneVideoUrls.length === 0) {
        throw new Error('לא הצלחתי ליצור אף סצנה בשיפור הסרטון — בדוק את חיבורי הספקים.');
      }
      let newVideoUrl = sceneVideoUrls[0] || resultVideoUrl || '';

      // Composite with narration + subtitles + logo
      if (sceneVideoUrls.length > 0) {
        const logoUrl = uploadedImages[0] || activeBrand?.logo || undefined;
        setProgressStage('מרכיב כתוביות, קריינות ולוגו...');
        try {
          const renderResult = await composeService.render({
            videoUrl: sceneVideoUrls[0],
            videoUrls: sceneVideoUrls,
            scenes: workingScenes.slice(0, sceneVideoUrls.length),
            logoUrl,
            brandColors: activeBrand?.colors || [],
            audioUrl: narrationAudioUrl,
          });
          if (renderResult?.renderId) {
            for (let i = 0; i < 90; i++) {
              const status = await composeService.checkStatus(renderResult.renderId, renderResult.shotstackEnv);
              if (status.status === 'done' && status.url) {
                newVideoUrl = status.url;
                break;
              }
              if (status.status === 'failed') throw new Error('Shotstack render failed');
              await sleep(3000);
            }
          }
        } catch (compErr: any) {
          throw new Error(`שלב ההרכבה בשיפור נכשל: ${compErr?.message || 'שגיאה ב-Shotstack'}`);
        }
      }

      setResultVideoUrl(newVideoUrl);
      setStep(4);
      setProgressStage('');
      setImprovePrompt('');
      toast.success('🎬 הסרטון המשופר מוכן!');
    } catch (e: any) {
      toast.error(e.message || 'שגיאה בשיפור הסרטון');
      setStep(4);
      setProgressStage('');
    } finally {
      setIsImproving(false);
      setRunwayPolling(false);
    }
  };

  const handleSave = async () => {
    if (!activeBrandId || !activeBrand || !resultVideoUrl) return;
    setSavingOutput(true);
    try {
      const cat = effectiveCategory || undefined;
      const project = await projectService.findOrCreateByBrand(activeBrandId, activeBrand.name, cat);
      await projectService.addOutput(project.id, {
        name: `סרטון — ${activeBrand.name}${cat ? ` — ${cat}` : ''}`,
        description: generatedScript?.title || prompt,
        video_url: resultVideoUrl,
        thumbnail_url: selectedAvatars[0]?.image_url || null,
        prompt: prompt || null,
        script: generatedScript?.script || null,
      });
      toast.success(`נשמר בפרויקט "${activeBrand.name}${cat ? ` — ${cat}` : ''}"!`);
    } catch (e: any) {
      toast.error(e.message || 'שגיאה בשמירה');
    } finally {
      setSavingOutput(false);
    }
  };

  const handleDownload = async () => {
    if (!resultVideoUrl) return;
    try {
      const res = await fetch(resultVideoUrl);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `${activeBrand?.name || 'video'}-${Date.now()}.mp4`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
      toast.success('ההורדה החלה');
    } catch { if (resultVideoUrl) window.open(resultVideoUrl, '_blank'); }
  };

  const updateSceneText = (idx: number, field: keyof ScriptScene, value: string) => {
    if (!generatedScript) return;
    setGeneratedScript({
      ...generatedScript,
      scenes: generatedScript.scenes.map((s, i) =>
        i === idx ? { ...s, [field]: value } : s
      ),
    });
  };

  const stepTitles = [
    { title: 'תאר את הסרטון', desc: 'ספר מה צריך לקרות בסרטון, בחר אווטארים וקולות' },
    { title: 'אשר את התסריט', desc: 'בדוק ועדכן את התסריט שנוצר' },
    { title: 'הגדרות סופיות', desc: 'הוסף תמונות ולוגו, ובדוק הכל לפני ייצור' },
    { title: 'מייצר סרטון...', desc: 'אנא המתן, הסרטון בהכנה' },
    { title: 'הסרטון מוכן!', desc: 'צפה, הורד, שפר או שמור' },
  ];

  const totalSteps = 5;

  return (
    <div className="space-y-4">
      {/* Progress */}
      <div className="flex items-center gap-1.5">
        {Array.from({ length: totalSteps }).map((_, i) => (
          <div key={i} className={cn(
            'h-1.5 rounded-full flex-1 transition-all',
            i <= step ? 'bg-primary' : 'bg-muted'
          )} />
        ))}
      </div>
      <div className="text-right">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Video className="w-4 h-4 text-primary" />
          {stepTitles[step].title}
        </h3>
        <p className="text-xs text-muted-foreground">{stepTitles[step].desc}</p>
      </div>

      {/* ===== STEP 0: Prompt + selection ===== */}
      {step === 0 && (
        <div className="space-y-4">
          {/* Prompt */}
          <div className="relative">
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => e.stopPropagation()}
              placeholder='ספר מה צריך לקרות בסרטון... למשל: "סרטון תדמית לחברה שמציג את השירותים שלנו עם הוק תופס בהתחלה"'
              rows={4}
              dir="rtl"
              className="w-full bg-muted/50 border border-border rounded-lg px-4 py-3 pl-12 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            {speechSupported && (
              <button type="button" onClick={toggleSpeech}
                className={cn('absolute left-3 top-3 p-1.5 rounded-lg transition-all',
                  isListening ? 'bg-destructive/10 text-destructive animate-pulse' : 'bg-muted/50 text-muted-foreground hover:text-foreground')}>
                {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
            )}
          </div>

          {/* Video Type selector */}
          <div className="bg-card border border-border rounded-xl p-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              🎯 סוג הסרטון
            </p>
            <div className="grid grid-cols-3 gap-2">
              {VIDEO_TYPE_OPTIONS.map(vt => (
                <button key={vt.value} onClick={() => {
                  setVideoType(vt.value);
                  // Auto-adjust duration to first valid preset
                  const firstPreset = DURATION_PRESETS.find(p => p.videoTypes.includes(vt.value));
                  if (firstPreset) setTargetDurationSec(firstPreset.seconds);
                }}
                  className={cn('text-right p-2.5 rounded-lg border text-xs transition-all',
                    videoType === vt.value
                      ? 'border-primary bg-primary/10 text-foreground shadow-sm'
                      : 'border-border hover:border-primary/30 text-muted-foreground')}>
                  <div className="font-medium">{vt.icon} {vt.label}</div>
                  <div className="text-[10px] mt-0.5 opacity-70">{vt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Duration selector */}
          <div className="bg-card border border-border rounded-xl p-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              ⏱ משך הסרטון
            </p>
            <div className="flex flex-wrap gap-2">
              {DURATION_PRESETS.filter(p => p.videoTypes.includes(videoType)).map(p => (
                <button key={p.seconds} onClick={() => setTargetDurationSec(p.seconds)}
                  className={cn('px-3 py-1.5 rounded-lg border text-xs transition-all',
                    targetDurationSec === p.seconds
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border hover:border-primary/30 text-muted-foreground')}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <input type="number" min={30} max={600} step={10} value={targetDurationSec}
                onChange={e => setTargetDurationSec(Math.max(30, Math.min(600, Number(e.target.value))))}
                className="w-20 bg-muted/50 border border-border rounded-lg px-2 py-1.5 text-xs text-center" />
              <span className="text-[10px] text-muted-foreground">שניות ({formatDuration(targetDurationSec)})</span>
            </div>
            {targetDurationSec > 120 && (
              <p className="text-[10px] text-amber-500">
                ⚠️ סרטון ארוך ({formatDuration(targetDurationSec)}) — ייווצרו ~{Math.round(targetDurationSec / 10)} סצנות קצרות וירוכבו ל-MP4 אחד דרך Shotstack.
              </p>
            )}
            {(() => {
              const maxDur = VIDEO_TYPE_OPTIONS.find(v => v.value === videoType)?.maxDuration || 600;
              if (targetDurationSec > maxDur) return (
                <p className="text-[10px] text-destructive">
                  ⛔ חריגה ממשך מקסימלי ({formatDuration(maxDur)}) למצב {VIDEO_TYPE_OPTIONS.find(v => v.value === videoType)?.label}. הסרטון עלול להיקטע.
                </p>
              );
              return null;
            })()}
          </div>
          {/* Video style selector */}
          <div className="bg-card border border-border rounded-xl p-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Video className="w-3.5 h-3.5" /> סגנון הסרטון
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {[
                { value: 'cinematic', label: '🎬 קולנועי ריאליסטי', desc: 'אנשים אמיתיים, לוקיישנים אמיתיים' },
                { value: 'disney', label: '🏰 דיסני / פיקסאר', desc: 'אנימציה תלת-ממדית צבעונית' },
                { value: 'anime', label: '🎌 אנימה', desc: 'סגנון יפני מפורט' },
                { value: 'cartoon', label: '🎨 קריקטורה / איור', desc: 'ציורים חיים ומצוירים' },
                { value: 'documentary', label: '📹 דוקומנטרי', desc: 'סגנון תיעודי מקצועי' },
                { value: 'commercial', label: '📺 פרסומת TV', desc: 'הפקה ברמת פרסומת טלוויזיה' },
              ].map(s => (
                <button key={s.value} onClick={() => setVideoStyle(s.value)}
                  className={cn('text-right p-2.5 rounded-lg border text-xs transition-all',
                    videoStyle === s.value
                      ? 'border-primary bg-primary/10 text-foreground shadow-sm'
                      : 'border-border hover:border-primary/30 text-muted-foreground')}>
                  <div className="font-medium">{s.label}</div>
                  <div className="text-[10px] mt-0.5 opacity-70">{s.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Info about duration */}
          <div className="bg-primary/5 border border-primary/20 rounded-lg px-3 py-2 text-xs text-muted-foreground flex items-start gap-2">
            <Sparkles className="w-3.5 h-3.5 text-primary mt-0.5 flex-shrink-0" />
            <span>הסרטון יהיה <strong className="text-foreground">{formatDuration(targetDurationSec)}</strong> (~{Math.round(targetDurationSec / 10)} סצנות). המערכת תוסיף קריינות בעברית, כתוביות, לוגו ואייקונים אוטומטית.</span>
          </div>

          {/* Avatars multi-select */}
          {avatars.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <UserCircle className="w-3.5 h-3.5" /> בחר אווטארים (ניתן לבחור כמה)
              </p>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {avatars.map(avatar => {
                  const selected = selectedAvatarIds.includes(avatar.id);
                  return (
                    <button key={avatar.id} onClick={() => toggleAvatar(avatar.id)}
                      className={cn('flex-shrink-0 w-16 h-16 rounded-lg border-2 overflow-hidden transition-all relative',
                        selected ? 'border-primary shadow-gold' : 'border-border hover:border-primary/30')}>
                      <img src={avatar.image_url} alt={avatar.name} className="w-full h-full object-cover" />
                      {selected && (
                        <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                          <Check className="w-5 h-5 text-primary drop-shadow" />
                        </div>
                      )}
                      <p className="absolute bottom-0 inset-x-0 text-[8px] text-center bg-background/80 py-0.5 truncate px-1">{avatar.name}</p>
                    </button>
                  );
                })}
              </div>
              {selectedAvatars.length > 0 && (
                <p className="text-xs text-primary">
                  נבחרו: {selectedAvatars.map(a => a.name).join(', ')}
                </p>
              )}
            </div>
          )}

          {/* Voices multi-select */}
          {voices.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Volume2 className="w-3.5 h-3.5" /> בחר קולות (ניתן לבחור כמה)
              </p>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setUseAiVoice(!useAiVoice)}
                  className={cn('px-3 py-1.5 rounded-lg border text-xs transition-all flex items-center gap-1.5',
                    useAiVoice ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-primary/30 text-muted-foreground')}>
                  <Sparkles className="w-3 h-3" /> קול AI אוטומטי
                </button>
                {voices.map(voice => {
                  const selected = selectedVoiceIds.includes(voice.id);
                  return (
                    <button key={voice.id} onClick={() => toggleVoice(voice.id)}
                      className={cn('px-3 py-1.5 rounded-lg border text-xs transition-all flex items-center gap-1.5',
                        selected ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-primary/30 text-muted-foreground')}>
                      {selected && <Check className="w-3 h-3" />}
                      <Volume2 className="w-3 h-3" />
                      {voice.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Images */}
          <div className="bg-card border border-border rounded-xl p-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <ImageIcon className="w-3.5 h-3.5" /> תמונות / לוגו ({uploadedImages.length}/{MAX_IMAGES})
            </p>
            <p className="text-[10px] text-muted-foreground">התמונה הראשונה תשמש כלוגו על הסרטון</p>
            {uploadedImages.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {uploadedImages.map((url, i) => (
                  <div key={i} className="relative group w-14 h-14 rounded-lg overflow-hidden border border-border">
                    <img src={url} alt="" className="w-full h-full object-cover" />
                    {i === 0 && (
                      <span className="absolute top-0.5 left-0.5 text-[8px] bg-primary text-primary-foreground px-1 rounded">לוגו</span>
                    )}
                    <button onClick={() => setUploadedImages(prev => prev.filter((_, idx) => idx !== i))}
                      className="absolute top-0.5 right-0.5 w-4 h-4 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {uploadedImages.length < MAX_IMAGES && (
              <FileUploadZone accept="image/*" multiple label="העלה לוגו / תמונות" hint="JPG, PNG — התמונה הראשונה = לוגו"
                onUploaded={url => { if (url) setUploadedImages(prev => [...prev, url]); }}
                onMultipleUploaded={urls => setUploadedImages(prev => [...prev, ...urls].slice(0, MAX_IMAGES))}
              />
            )}
          </div>

          {/* Website URL scraper */}
          <div className="bg-card border border-border rounded-xl p-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5" /> קישור לאתר (אופציונלי)
            </p>
            <p className="text-[10px] text-muted-foreground">הדבק קישור לאתר שלך — המערכת תסרוק אותו ותשלב תוכן, צבעים ומבנה בסרטון</p>

            {websiteData ? (
              <div className="bg-muted/30 border border-border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <Check className="w-4 h-4 text-primary flex-shrink-0" />
                    <span className="text-sm font-medium truncate">{websiteData.metadata?.title || websiteUrl}</span>
                  </div>
                  <button onClick={() => { setWebsiteData(null); setWebsiteUrl(''); }}
                    className="w-6 h-6 rounded-full hover:bg-muted flex items-center justify-center flex-shrink-0">
                    <X className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                </div>
                {websiteData.metadata?.description && (
                  <p className="text-[10px] text-muted-foreground line-clamp-2">{websiteData.metadata.description}</p>
                )}
                {websiteData.branding?.colors && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground">צבעי האתר:</span>
                    {Object.values(websiteData.branding.colors).slice(0, 6).map((color, i) => (
                      <div key={i} className="w-4 h-4 rounded-full border border-border" style={{ backgroundColor: color }} />
                    ))}
                  </div>
                )}
                {(() => {
                  const imgUrl = websiteScraperService.getScreenshotUrl(websiteData);
                  return imgUrl ? (
                    <div className="rounded-lg overflow-hidden border border-border max-h-40">
                      <img src={imgUrl} alt="צילום מסך" className="w-full object-cover object-top" />
                    </div>
                  ) : null;
                })()}
              </div>
            ) : (
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Globe className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    value={websiteUrl}
                    onChange={e => setWebsiteUrl(e.target.value)}
                    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') handleScrapeWebsite(); }}
                    placeholder="https://www.example.com"
                    className="w-full bg-muted/50 border border-border rounded-lg pr-10 pl-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    dir="ltr"
                  />
                </div>
                <button onClick={handleScrapeWebsite} disabled={!websiteUrl.trim() || scrapingWebsite}
                  className="px-4 py-2.5 border border-border rounded-lg text-sm hover:bg-muted disabled:opacity-50 flex items-center gap-1.5">
                  {scrapingWebsite ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                  {scrapingWebsite ? 'סורק...' : 'סרוק'}
                </button>
              </div>
            )}
          </div>

          <button onClick={handleGenerateScript} disabled={loading}
            className="w-full gradient-gold text-primary-foreground px-6 py-3 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {loading ? 'יוצר תסריט...' : 'צור תסריט'}
          </button>
        </div>
      )}

      {/* ===== STEP 1: Script review ===== */}
      {step === 1 && generatedScript && (
        <div className="space-y-4">
          {/* Script title & overview */}
          <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 space-y-1">
            <p className="text-sm font-semibold text-primary">{generatedScript.title}</p>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>⏱ {generatedScript.duration} שניות</span>
              <span>🎬 {generatedScript.scenes.length} סצנות</span>
              {generatedScript.style?.tone && <span>🎭 {generatedScript.style.tone}</span>}
            </div>
          </div>

          {/* Full script text */}
          <div className="bg-card border border-border rounded-xl p-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" /> תסריט מלא
            </p>
            <textarea
              value={generatedScript.script}
              onChange={e => setGeneratedScript({ ...generatedScript, script: e.target.value })}
              onKeyDown={e => e.stopPropagation()}
              rows={4}
              dir="rtl"
              className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* Scenes */}
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {generatedScript.scenes.map((scene, idx) => (
              <div key={scene.id || idx} className="bg-card border border-border rounded-xl overflow-hidden">
                <button onClick={() => setEditingSceneIdx(editingSceneIdx === idx ? null : idx)}
                  className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/50 transition-colors">
                  <div className="flex items-center gap-2 text-right">
                    <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold">{idx + 1}</span>
                    <div>
                      <p className="text-xs font-medium">{scene.title}</p>
                      <p className="text-[10px] text-muted-foreground">{scene.speaker} • {scene.duration}s</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {scene.icons?.map((icon, i) => <span key={i} className="text-sm">{icon}</span>)}
                    {editingSceneIdx === idx ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </button>
                {editingSceneIdx === idx && (
                  <div className="px-3 pb-3 space-y-2 border-t border-border pt-2">
                    <div>
                      <label className="text-[10px] text-muted-foreground">דובר</label>
                      <input value={scene.speaker} onChange={e => updateSceneText(idx, 'speaker', e.target.value)}
                        onKeyDown={e => e.stopPropagation()}
                        className="w-full bg-muted/50 border border-border rounded-lg px-2 py-1.5 text-xs" dir="rtl" />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground">🎙️ טקסט מדובר (קריינות)</label>
                      <textarea value={scene.spokenText} onChange={e => updateSceneText(idx, 'spokenText', e.target.value)}
                        onKeyDown={e => e.stopPropagation()}
                        rows={2} className="w-full bg-muted/50 border border-border rounded-lg px-2 py-1.5 text-xs resize-none" dir="rtl" />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground font-semibold text-primary">🎬 בימוי חזותי מלא — זה מה שהמנוע רואה!</label>
                      <textarea value={scene.visualDescription} onChange={e => updateSceneText(idx, 'visualDescription', e.target.value)}
                        onKeyDown={e => e.stopPropagation()}
                        rows={5} className="w-full bg-primary/5 border border-primary/30 rounded-lg px-2 py-1.5 text-xs resize-none" dir="rtl"
                        placeholder="תאר כאילו אתה במאי: פריים פתיחה, דמות מרכזית, פעולה, Foreground, Midground, Background, תאורה, צבעים, טקסטורות..." />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground font-semibold text-primary">🎭 אקשן ברקע — מה שנותן חיים לסצנה!</label>
                      <textarea value={scene.backgroundAction || ''} onChange={e => updateSceneText(idx, 'backgroundAction', e.target.value)}
                        onKeyDown={e => e.stopPropagation()}
                        rows={3} className="w-full bg-primary/5 border border-primary/30 rounded-lg px-2 py-1.5 text-xs resize-none" dir="rtl"
                        placeholder="אנשים ברקע, תנועה סביבתית, אינטראקציות, אלמנטים חיים, צלילים ויזואליים..." />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground">👥 דמויות — casting מפורט</label>
                      <textarea value={scene.characters || ''} onChange={e => updateSceneText(idx, 'characters', e.target.value)}
                        onKeyDown={e => e.stopPropagation()}
                        rows={2} className="w-full bg-muted/50 border border-border rounded-lg px-2 py-1.5 text-xs resize-none" dir="rtl"
                        placeholder="דמות מרכזית: גיל, מראה, ביגוד, הבעה, תנוחה. דמויות משניות..." />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-muted-foreground">📷 תנועת מצלמה</label>
                        <input value={scene.cameraDirection || ''} onChange={e => updateSceneText(idx, 'cameraDirection', e.target.value)}
                          onKeyDown={e => e.stopPropagation()}
                          className="w-full bg-muted/50 border border-border rounded-lg px-2 py-1.5 text-xs" dir="rtl"
                          placeholder="Dolly In, Close-Up, Tracking Shot..." />
                      </div>
                      <div>
                        <label className="text-[10px] text-muted-foreground">🎨 סגנון</label>
                        <select value={scene.videoStyle || videoStyle || 'cinematic'} onChange={e => updateSceneText(idx, 'videoStyle', e.target.value)}
                          className="w-full bg-muted/50 border border-border rounded-lg px-2 py-1.5 text-xs">
                          <option value="cinematic">🎬 קולנועי</option>
                          <option value="disney">🏰 דיסני/פיקסאר</option>
                          <option value="anime">🎌 אנימה</option>
                          <option value="cartoon">🎨 קריקטורה</option>
                          <option value="documentary">📹 דוקומנטרי</option>
                          <option value="commercial">📺 פרסומת</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground">🌍 סביבה, תאורה ואווירה</label>
                      <textarea value={scene.environment || ''} onChange={e => updateSceneText(idx, 'environment', e.target.value)}
                        onKeyDown={e => e.stopPropagation()}
                        rows={2} className="w-full bg-muted/50 border border-border rounded-lg px-2 py-1.5 text-xs resize-none" dir="rtl"
                        placeholder="מבנה החלל, ריהוט, תאורה מדויקת, אווירה, פרטים ייחודיים..." />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground">💬 כתובית על המסך</label>
                      <input value={scene.subtitleText} onChange={e => updateSceneText(idx, 'subtitleText', e.target.value)}
                        onKeyDown={e => e.stopPropagation()}
                        className="w-full bg-muted/50 border border-border rounded-lg px-2 py-1.5 text-xs" dir="rtl" />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <button onClick={() => setStep(0)}
              className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm hover:bg-muted flex items-center justify-center gap-2">
              <Edit3 className="w-4 h-4" /> חזור לתיאור
            </button>
            <button onClick={() => setStep(2)}
              className="flex-1 gradient-gold text-primary-foreground px-4 py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2">
              <Check className="w-4 h-4" /> אשר תסריט
            </button>
          </div>
        </div>
      )}

      {/* ===== STEP 2: Final settings ===== */}
      {step === 2 && generatedScript && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="bg-card border border-border rounded-xl p-3 space-y-2">
            <p className="text-xs font-semibold">סיכום</p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-muted/50 rounded-lg p-2">
                <span className="text-muted-foreground">תסריט:</span>
                <p className="font-medium truncate">{generatedScript.title}</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-2">
                <span className="text-muted-foreground">סצנות:</span>
                <p className="font-medium">{generatedScript.scenes.length}</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-2">
                <span className="text-muted-foreground">אווטארים:</span>
                <p className="font-medium">{selectedAvatars.length > 0 ? selectedAvatars.map(a => a.name).join(', ') : 'ללא'}</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-2">
                <span className="text-muted-foreground">קולות:</span>
                <p className="font-medium">{selectedVoices.length > 0 ? selectedVoices.map(v => v.name).join(', ') : useAiVoice ? 'AI אוטומטי' : 'ללא'}</p>
              </div>
            </div>
            {uploadedImages.length > 0 && (
              <div className="flex gap-2 pt-1">
                {uploadedImages.map((url, i) => (
                  <div key={i} className="w-10 h-10 rounded-lg overflow-hidden border border-border relative">
                    <img src={url} alt="" className="w-full h-full object-cover" />
                    {i === 0 && <span className="absolute top-0 left-0 text-[6px] bg-primary text-primary-foreground px-0.5 rounded-br">לוגו</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Category selector */}
          {activeBrand && (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-muted-foreground">תת-פעילות / קטגוריה</label>
              {brandDepartments.length > 0 && (
                <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}
                  className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" dir="rtl">
                  <option value="">בחר...</option>
                  {brandDepartments.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              )}
              <input value={customCategory} onChange={e => setCustomCategory(e.target.value)}
                placeholder="או כתוב תת-פעילות חדשה"
                className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" dir="rtl" />
            </div>
          )}

          {/* Dry-run / Preflight toggle */}
          <div className="flex items-center gap-2 bg-muted/30 border border-border rounded-lg px-3 py-2">
            <input type="checkbox" id="dryRun" checked={dryRunMode} onChange={e => setDryRunMode(e.target.checked)}
              className="rounded border-border" />
            <label htmlFor="dryRun" className="text-xs text-muted-foreground cursor-pointer">
              🔍 מצב בדיקה מוקדמת (Dry Run) — בודק ספקים בלי לבזבז קרדיטים
            </label>
          </div>

          <div className="flex gap-2">
            <button onClick={() => setStep(1)}
              className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm hover:bg-muted flex items-center justify-center gap-2">
              חזור לתסריט
            </button>
            <button onClick={requestGenerateVideo} disabled={loading}
              className="flex-1 gradient-gold text-primary-foreground px-4 py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50">
              <Play className="w-4 h-4" /> {dryRunMode ? 'בדוק מוכנות' : '💰 צור סרטון (בתשלום)'}
            </button>
          </div>

          {/* Preflight result */}
          {preflightResult && (
            <div className={cn('border rounded-lg p-3 space-y-1 text-xs', preflightResult.ok ? 'border-primary/30 bg-primary/5' : 'border-destructive/30 bg-destructive/5')}>
              <p className="font-semibold">{preflightResult.ok ? '✅ בדיקה מוקדמת עברה' : '❌ בדיקה מוקדמת נכשלה'}</p>
              <p className="text-muted-foreground font-mono text-[10px]">Run ID: {preflightResult.runId}</p>
              {preflightResult.errors.map((e, i) => <p key={i} className="text-destructive">❌ {e}</p>)}
              {preflightResult.warnings.map((w, i) => <p key={i} className="text-amber-500">⚠️ {w}</p>)}
              <div className="flex flex-wrap gap-1.5 pt-1">
                {Object.entries(preflightResult.providerHealth).map(([name, status]) => (
                  <span key={name} className={cn('px-2 py-0.5 rounded-full text-[10px] border',
                    status === 'healthy' ? 'bg-primary/10 text-primary border-primary/30' :
                    status === 'degraded' ? 'bg-amber-500/10 text-amber-500 border-amber-500/30' :
                    'bg-destructive/10 text-destructive border-destructive/30')}>
                    {status === 'healthy' ? '✓' : status === 'degraded' ? '⚠' : '✗'} {name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== STEP 3: Generating ===== */}
      {step === 3 && (
        <div className="space-y-4 text-center py-8">
          <Loader2 className="w-12 h-12 animate-spin text-primary mx-auto" />
          <p className="text-sm font-medium">{progressStage || 'מייצר את הסרטון...'}</p>
          <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
            <div className="bg-gradient-to-r from-primary to-primary/70 h-full rounded-full transition-all duration-700 ease-out" style={{ width: `${runwayProgress}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">{Math.round(runwayProgress)}% הושלם</p>
          <div className="flex flex-wrap justify-center gap-2 pt-2">
            {[
              { label: 'בדיקת ספקים', done: runwayProgress > 5 },
              { label: 'שכפול קול', done: runwayProgress > 15 },
              { label: 'יצירת וידאו', done: runwayProgress > 65 },
              { label: 'הרכבה סופית', done: runwayProgress > 95 },
            ].map(s => (
              <span key={s.label} className={cn(
                'text-[10px] px-2 py-0.5 rounded-full border',
                s.done ? 'bg-primary/10 text-primary border-primary/30' : 'bg-muted text-muted-foreground border-border'
              )}>
                {s.done ? '✓' : '○'} {s.label}
              </span>
            ))}
          </div>
          {/* Debug: current stage detail */}
          {progressStage && (
            <p className="text-[10px] text-muted-foreground/60 mt-2 font-mono" dir="ltr">
              {progressStage}
            </p>
          )}
          {activeRunId && (
            <p className="text-[10px] text-muted-foreground/40 font-mono" dir="ltr">Run: {activeRunId}</p>
          )}
          {/* Debug panel toggle */}
          <button onClick={() => setShowDebugPanel(!showDebugPanel)}
            className="text-[10px] text-muted-foreground hover:text-foreground underline">
            {showDebugPanel ? 'הסתר לוג דיבאג' : 'הצג לוג דיבאג'}
          </button>
          {showDebugPanel && debugLogs.length > 0 && (
            <div className="bg-muted/20 border border-border rounded-lg p-2 max-h-[200px] overflow-y-auto text-right" dir="rtl">
              {debugLogs.map((log, i) => (
                <div key={i} className={cn('text-[10px] font-mono py-0.5 border-b border-border/30 last:border-0',
                  log.status === 'error' ? 'text-destructive' : log.status === 'warn' ? 'text-amber-500' : log.status === 'success' ? 'text-primary' : 'text-muted-foreground')}>
                  <span className="opacity-50">{log.timestamp.split('T')[1]?.slice(0, 8)}</span>{' '}
                  [{log.step}] {log.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ===== STEP 4: Result ===== */}
      {step === 4 && resultVideoUrl && (
        <div className="space-y-4">
          <div className="rounded-xl overflow-hidden border border-border bg-muted/30">
            <video src={resultVideoUrl} controls loop className="w-full max-h-[300px]" />
          </div>

          {/* Improve section */}
          <div className="bg-card border border-primary/20 rounded-xl p-3 space-y-2">
            <p className="text-xs font-semibold flex items-center gap-1.5">
              <Wand2 className="w-3.5 h-3.5 text-primary" /> שפר את הסרטון
            </p>
            <p className="text-[10px] text-muted-foreground">תאר מה לשנות — למשל: "יותר צבעוני", "הוסף תנועה", "שים דגש על המוצרים"</p>
            <div className="flex gap-2">
              <input
                value={improvePrompt}
                onChange={e => setImprovePrompt(e.target.value)}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') requestImproveVideo(); }}
                placeholder="מה לשפר..."
                dir="rtl"
                className="flex-1 bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <button onClick={requestImproveVideo} disabled={isImproving || !improvePrompt.trim()}
                className="px-4 py-2 gradient-gold text-primary-foreground rounded-lg text-sm font-semibold disabled:opacity-50 flex items-center gap-1.5">
                {isImproving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                שפר
              </button>
            </div>
          </div>

          {activeBrand && (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-muted-foreground">תת-פעילות / קטגוריה</label>
              {brandDepartments.length > 0 && (
                <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}
                  className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" dir="rtl">
                  <option value="">בחר...</option>
                  {brandDepartments.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              )}
              <input value={customCategory} onChange={e => setCustomCategory(e.target.value)}
                placeholder="או כתוב תת-פעילות חדשה"
                className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" dir="rtl" />
            </div>
          )}

          <div className="flex gap-2">
            <button onClick={handleDownload}
              className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm hover:bg-muted flex items-center justify-center gap-2">
              <Download className="w-4 h-4" /> הורד
            </button>
            <button onClick={handleSave} disabled={savingOutput}
              className="flex-1 gradient-gold text-primary-foreground px-4 py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50">
              {savingOutput ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {savingOutput ? 'שומר...' : 'שמור'}
            </button>
          </div>

          <button onClick={() => { setStep(1); setResultVideoUrl(null); }}
            className="w-full text-sm text-muted-foreground hover:text-foreground flex items-center justify-center gap-1 py-2">
            <Edit3 className="w-3.5 h-3.5" /> ערוך תסריט ותייצר מחדש
          </button>
          <button onClick={() => { setStep(0); setResultVideoUrl(null); setGeneratedScript(null); setPrompt(''); }}
            className="w-full text-sm text-muted-foreground hover:text-foreground flex items-center justify-center gap-1 py-1">
            <RefreshCw className="w-3.5 h-3.5" /> התחל מחדש
          </button>

          {/* Debug log for completed run */}
          {debugLogs.length > 0 && (
            <div className="pt-2">
              <button onClick={() => setShowDebugPanel(!showDebugPanel)}
                className="text-[10px] text-muted-foreground hover:text-foreground underline">
                {showDebugPanel ? 'הסתר לוג דיבאג' : `הצג לוג דיבאג (${debugLogs.length} שלבים)`}
              </button>
              {activeRunId && <p className="text-[10px] text-muted-foreground/40 font-mono" dir="ltr">Run: {activeRunId}</p>}
              {showDebugPanel && (
                <div className="bg-muted/20 border border-border rounded-lg p-2 max-h-[200px] overflow-y-auto text-right mt-1" dir="rtl">
                  {debugLogs.map((log, i) => (
                    <div key={i} className={cn('text-[10px] font-mono py-0.5 border-b border-border/30 last:border-0',
                      log.status === 'error' ? 'text-destructive' : log.status === 'warn' ? 'text-amber-500' : log.status === 'success' ? 'text-primary' : 'text-muted-foreground')}>
                      <span className="opacity-50">{log.timestamp.split('T')[1]?.slice(0, 8)}</span>{' '}
                      [{log.step}] {log.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {/* Cost approval dialog */}
      <CostApprovalDialog
        open={showCostApproval}
        onOpenChange={setShowCostApproval}
        estimates={costEstimates}
        onApprove={handleCostApproved}
        title="אישור יצירת סרטון בתשלום"
      />
    </div>
  );
}
