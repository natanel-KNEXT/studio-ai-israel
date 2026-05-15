import { AppLayout } from '@/components/layout/AppLayout';
import { useState, useEffect, useRef } from 'react';
import { Mic, Plus, Trash2, X, Play, Pause, Loader2, Download, DollarSign, FileText, ChevronDown, ChevronUp, Info, RefreshCw, ShieldCheck, ShieldAlert, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { VoiceRecorder } from '@/components/VoiceRecorder';
import { FileUploadZone } from '@/components/FileUploadZone';
import { VoiceDictationButton } from '@/components/VoiceDictationButton';
import { supabase } from '@/integrations/supabase/client';
import { CostApprovalDialog, CostEstimate } from '@/components/studio/CostApprovalDialog';

interface SavedVoice {
  id: string;
  name: string;
  audio_url: string;
  type: 'recorded' | 'uploaded';
  provider_voice_id?: string | null;
  created_at: string;
  // Enriched fields from voice-manager
  is_verified?: boolean;
  verification_status?: string;
  verification_updated_at?: string | null;
  verification_sample_url?: string | null;
  verification_selected_model?: string | null;
  training_audio_file_name?: string | null;
}

interface VoiceGeneration {
  id: string;
  title: string;
  script: string;
  voice_id: string | null;
  voice_name: string;
  provider: string;
  audio_url: string;
  duration_seconds: number | null;
  created_at: string;
  // Enriched
  provider_voice_id_used?: string | null;
  model_id_used?: string | null;
  language_code_used?: string | null;
  voice_settings_used?: Record<string, unknown> | null;
  is_verification_record?: boolean;
}

interface TrainingAudioAudit {
  url: string;
  sizeBytes: number | null;
  durationSec: number | null;
  contentType: string | null;
  codec: string | null;
}

interface VerificationABSamples {
  optionAUrl: string;
  optionBUrl: string;
  providerVoiceId: string;
}

// Vibe/Delivery presets
const VIBE_PRESETS: Record<string, { label: string; settings: { stability: number; similarity_boost: number; style?: number; use_speaker_boost: boolean; speed: number } }> = {
  default: { label: 'רגיל', settings: { stability: 0.45, similarity_boost: 0.9, use_speaker_boost: true, speed: 1 } },
  happy: { label: 'שמח / עליז', settings: { stability: 0.35, similarity_boost: 0.9, style: 0.4, use_speaker_boost: true, speed: 1.05 } },
  sad: { label: 'עצוב / אמפתי', settings: { stability: 0.55, similarity_boost: 0.9, style: 0.3, use_speaker_boost: true, speed: 0.9 } },
  energetic: { label: 'אנרגטי / מכירתי', settings: { stability: 0.3, similarity_boost: 0.9, style: 0.6, use_speaker_boost: true, speed: 1.1 } },
  calm: { label: 'רגוע / מקצועי', settings: { stability: 0.6, similarity_boost: 0.9, style: 0.1, use_speaker_boost: true, speed: 0.95 } },
  gentle: { label: 'מתנצל / עדין', settings: { stability: 0.55, similarity_boost: 0.9, style: 0.2, use_speaker_boost: true, speed: 0.9 } },
};

function preprocessPauses(text: string): string {
  let result = text.replace(/\n\n+/g, '... ... ');
  result = result.replace(/\n/g, '... ');
  return result;
}

const VERIFICATION_TEST_SENTENCE = 'שלום, אני בודק את הקול שלי. זה נשמע כמוני?';

export default function VoicesManagePage() {
  const [voices, setVoices] = useState<SavedVoice[]>([]);
  const [generations, setGenerations] = useState<VoiceGeneration[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Script-to-Voice state
  const [showScriptToVoice, setShowScriptToVoice] = useState(false);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>('');
  const [scriptText, setScriptText] = useState('');
  const [scriptTitle, setScriptTitle] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generatedAudioUrl, setGeneratedAudioUrl] = useState<string | null>(null);
  const [generatedVoiceId, setGeneratedVoiceId] = useState<string | null>(null);
  const [costApprovalOpen, setCostApprovalOpen] = useState(false);
  const [savingGeneration, setSavingGeneration] = useState(false);
  const [language, setLanguage] = useState<'he' | 'en' | 'ar'>('he');
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generationErrorMeta, setGenerationErrorMeta] = useState<{
    functionName?: string;
    status?: number;
    providerError?: string;
  } | null>(null);

  const [vibePreset, setVibePreset] = useState<string>('default');
  const [respectPauses, setRespectPauses] = useState(true);
  const [techDetails, setTechDetails] = useState<{
    selectedVoiceId: string;
    providerVoiceIdSent: string;
    voiceIdReturned: string;
    clonedFresh: boolean;
    provider: string;
    modelId: string;
    language: string;
    voiceSettings: Record<string, unknown>;
    trainingAudioUrlUsed?: string | null;
    trainingAudioDurationSec?: number | null;
    trainingAudioSizeBytes?: number | null;
    trainingAudioContentType?: string | null;
    trainingAudioCodec?: string | null;
  } | null>(null);
  const [showTechDetails, setShowTechDetails] = useState(false);
  const [expandedGenId, setExpandedGenId] = useState<string | null>(null);

  // Reset / re-clone state
  const [resettingVoiceId, setResettingVoiceId] = useState<string | null>(null);

  // Training-audio audit state
  const [trainingAuditByVoiceId, setTrainingAuditByVoiceId] = useState<Record<string, TrainingAudioAudit>>({});

  // Verification state
  const [verifyingVoiceId, setVerifyingVoiceId] = useState<string | null>(null);
  const [verificationSamples, setVerificationSamples] = useState<VerificationABSamples | null>(null);
  const [verificationCostOpen, setVerificationCostOpen] = useState(false);
  const [pendingVerifyVoiceId, setPendingVerifyVoiceId] = useState<string | null>(null);

  // Expanded voice audit
  const [expandedVoiceId, setExpandedVoiceId] = useState<string | null>(null);

  useEffect(() => { loadAll(); }, []);

  const getCodecFromContentType = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const normalized = value.toLowerCase();
    const codecsMatch = normalized.match(/codecs\s*=\s*"?([^";]+)/);
    if (codecsMatch?.[1]) return codecsMatch[1].trim();
    if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
    if (normalized.includes('wav')) return 'wav';
    if (normalized.includes('ogg')) return 'ogg/opus';
    if (normalized.includes('webm')) return 'webm/opus';
    if (normalized.includes('m4a') || normalized.includes('mp4')) return 'aac';
    return null;
  };

  const measureAudioDuration = (url: string): Promise<number | null> =>
    new Promise((resolve) => {
      const audio = document.createElement('audio');
      const done = (value: number | null) => {
        audio.removeAttribute('src');
        audio.load();
        resolve(value);
      };

      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const seconds = Number.isFinite(audio.duration) ? audio.duration : null;
        done(seconds && seconds > 0 ? seconds : null);
      };
      audio.onerror = () => done(null);
      audio.src = url;
    });

  const fetchTrainingAudioAudit = async (voice: SavedVoice): Promise<TrainingAudioAudit> => {
    const [durationSec, headResponse] = await Promise.all([
      measureAudioDuration(voice.audio_url),
      fetch(voice.audio_url, { method: 'HEAD' }).catch(() => null),
    ]);

    const contentLength = headResponse?.headers.get('content-length');
    const contentType = headResponse?.headers.get('content-type') || null;

    return {
      url: voice.audio_url,
      durationSec,
      sizeBytes: contentLength ? Number(contentLength) || null : null,
      contentType,
      codec: getCodecFromContentType(contentType),
    };
  };

  const hydrateTrainingAudits = async (voiceList: SavedVoice[]) => {
    const tasks = voiceList.map(async (voice) => {
      if (!voice.audio_url) return null;
      try {
        const audit = await fetchTrainingAudioAudit(voice);
        return [voice.id, audit] as const;
      } catch {
        return [voice.id, {
          url: voice.audio_url,
          durationSec: null,
          sizeBytes: null,
          contentType: null,
          codec: null,
        } satisfies TrainingAudioAudit] as const;
      }
    });

    const rows = (await Promise.all(tasks)).filter((row): row is readonly [string, TrainingAudioAudit] => Boolean(row));
    if (!rows.length) return;

    setTrainingAuditByVoiceId((prev) => ({
      ...prev,
      ...Object.fromEntries(rows),
    }));
  };

  const getTrainingAuditForVoice = async (voice: SavedVoice): Promise<TrainingAudioAudit> => {
    const existing = trainingAuditByVoiceId[voice.id];
    if (existing) return existing;
    const fresh = await fetchTrainingAudioAudit(voice);
    setTrainingAuditByVoiceId((prev) => ({ ...prev, [voice.id]: fresh }));
    return fresh;
  };

  const loadAll = async () => {
    try {
      const [voicesRes, gensRes] = await Promise.all([
        supabase.functions.invoke('voice-manager', { body: { action: 'list' } }),
        supabase.functions.invoke('voice-manager', { body: { action: 'list_generations' } }),
      ]);
      if (voicesRes.data?.voices) {
        const loadedVoices = voicesRes.data.voices as SavedVoice[];
        setVoices(loadedVoices);
        void hydrateTrainingAudits(loadedVoices);
      }
      if (gensRes.data?.generations) {
        // Filter out verification records from visible generations
        const visible = (gensRes.data.generations as VoiceGeneration[]).filter(g => !g.is_verification_record);
        setGenerations(visible);
      }
    } catch (e: any) {
      console.error('Failed to load:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveVoice = async (audioUrl: string, type: 'recorded' | 'uploaded') => {
    if (!name.trim()) { toast.error('יש להזין שם לקול'); return; }
    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke('voice-manager', {
        body: { action: 'save', name, audio_url: audioUrl, type },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);

      const savedVoice = data.voice as SavedVoice;
      setVoices(prev => [savedVoice, ...prev]);
      void hydrateTrainingAudits([savedVoice]);

      setCreating(false);
      setName('');
      toast.success('הקול נשמר בהצלחה!');
    } catch (e: any) {
      toast.error(e.message || 'שגיאה בשמירת הקול');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const voice = voices.find(v => v.id === id);
      const { data, error } = await supabase.functions.invoke('voice-manager', {
        body: { action: 'delete', id },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      if (voice?.audio_url) {
        const match = voice.audio_url.match(/\/media\/(.+)$/);
        if (match) await supabase.storage.from('media').remove([match[1]]);
      }
      setVoices(prev => prev.filter(v => v.id !== id));
      toast.success('הקול הוסר');
    } catch (e: any) {
      toast.error(e.message || 'שגיאה במחיקת הקול');
    }
  };

  const handleDeleteGeneration = async (id: string) => {
    try {
      const gen = generations.find(g => g.id === id);
      const { data, error } = await supabase.functions.invoke('voice-manager', {
        body: { action: 'delete_generation', id },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      if (gen?.audio_url) {
        const match = gen.audio_url.match(/\/media\/(.+)$/);
        if (match) await supabase.storage.from('media').remove([match[1]]);
      }
      setGenerations(prev => prev.filter(g => g.id !== id));
      toast.success('הדיבוב הוסר');
    } catch (e: any) {
      toast.error(e.message || 'שגיאה במחיקה');
    }
  };

  const togglePlay = (id: string, url: string) => {
    if (playingId === id) {
      audioRef.current?.pause();
      setPlayingId(null);
    } else {
      if (audioRef.current) audioRef.current.pause();
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setPlayingId(null);
      audio.play();
      setPlayingId(id);
    }
  };

  // ══════════════════════════════════════════
  // ── RESET / RE-CLONE ──
  // ══════════════════════════════════════════
  const handleResetVoice = async (voiceId: string) => {
    const voice = voices.find(v => v.id === voiceId);
    if (!voice) return;

    setResettingVoiceId(voiceId);
    try {
      const { data, error } = await supabase.functions.invoke('voice-manager', {
        body: { action: 'reset_provider_voice_id', id: voiceId, delete_provider_voice: true },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);

      // Update local state
      setVoices(prev => prev.map(v =>
        v.id === voiceId
          ? { ...v, provider_voice_id: null, is_verified: false, verification_status: 'unverified', verification_sample_url: null }
          : v
      ));

      if (data.deleteWarning) {
        toast.warning(data.deleteWarning);
      }

      toast.success('הקול אופס. העלה קובץ אימון חדש (60-120 שניות) ובצע שכפול מחדש.');
    } catch (e: any) {
      toast.error(e.message || 'שגיאה באיפוס הקול');
    } finally {
      setResettingVoiceId(null);
    }
  };

  // ══════════════════════════════════════════
  // ── VOICE VERIFICATION ──
  // ══════════════════════════════════════════
  const requestVerification = (voiceId: string) => {
    setPendingVerifyVoiceId(voiceId);
    setVerificationSamples(null);
    setVerifyingVoiceId(null);
    setVerificationCostOpen(true);
  };

  const executeVerification = async () => {
    setVerificationCostOpen(false);
    const voiceId = pendingVerifyVoiceId;
    setPendingVerifyVoiceId(null);
    if (!voiceId) return;

    const voice = voices.find(v => v.id === voiceId);
    if (!voice) {
      toast.error('הקול לא נמצא');
      return;
    }

    setVerifyingVoiceId(voiceId);
    setVerificationSamples(null);

    try {
      const trainingAudit = await getTrainingAuditForVoice(voice);
      const durationSec = trainingAudit.durationSec;

      if (!durationSec || durationSec <= 0) {
        throw new Error('לא ניתן למדוד אורך אמיתי של קובץ האימון. בדוק שהקובץ תקין ונגיש.');
      }

      if (durationSec < 30) {
        throw new Error(
          'קובץ האימון קצר מדי (פחות מ-30 שניות) ולכן השכפול נחסם. הקלט 60-120 שניות, דובר אחד, חדר שקט, ללא מוזיקה/רעשים, עדיפות ל-WAV/MP3.'
        );
      }

      if (durationSec < 60) {
        toast.warning('אורך הקלטה קצר מ-60 שניות. אפשר להמשיך, אבל איכות זהות עשויה להיפגע.');
      }

      console.log('Training audio used for clone verification:', {
        url: trainingAudit.url,
        durationSec,
        sizeBytes: trainingAudit.sizeBytes,
        contentType: trainingAudit.contentType,
        codec: trainingAudit.codec,
      });

      let providerVoiceIdForTest = voice.provider_voice_id || null;

      const optionABody: Record<string, unknown> = {
        scriptText: VERIFICATION_TEST_SENTENCE,
        language: 'he',
        voiceSettings: VIBE_PRESETS.default.settings,
        modelId: 'eleven_v3',
      };

      if (providerVoiceIdForTest) {
        optionABody.providerVoiceId = providerVoiceIdForTest;
      } else {
        optionABody.audioUrl = voice.audio_url;
        optionABody.trainingAudioDurationSec = durationSec;
        optionABody.trainingAudioSizeBytes = trainingAudit.sizeBytes ?? undefined;
        optionABody.trainingAudioFileName = voice.training_audio_file_name ?? undefined;
        optionABody.trainingAudioContentType = trainingAudit.contentType ?? undefined;
        optionABody.trainingAudioCodec = trainingAudit.codec ?? undefined;
      }

      const { data: optionAData, error: optionAError } = await supabase.functions.invoke('clone-voice-tts', {
        body: optionABody,
      });

      if (optionAError) throw optionAError;
      if (optionAData?.error) throw new Error(optionAData.error);
      if (!optionAData?.audioUrl) throw new Error('לא התקבלה דגימת אימות עבור מודל A');

      if (optionAData.voiceId && !providerVoiceIdForTest) {
        providerVoiceIdForTest = optionAData.voiceId;
        await supabase.functions.invoke('voice-manager', {
          body: {
            action: 'update_provider_voice_id',
            id: voiceId,
            provider_voice_id: providerVoiceIdForTest,
          },
        });
      }

      if (!providerVoiceIdForTest) {
        throw new Error('לא התקבל provider_voice_id עבור בדיקת A/B');
      }

      const { data: optionBData, error: optionBError } = await supabase.functions.invoke('clone-voice-tts', {
        body: {
          providerVoiceId: providerVoiceIdForTest,
          scriptText: VERIFICATION_TEST_SENTENCE,
          language: 'he',
          modelId: 'eleven_multilingual_v2',
          omitLanguageCode: true,
          voiceSettings: VIBE_PRESETS.default.settings,
        },
      });

      if (optionBError) throw optionBError;
      if (optionBData?.error) throw new Error(optionBData.error);
      if (!optionBData?.audioUrl) throw new Error('לא התקבלה דגימת אימות עבור מודל B');

      setVoices(prev => prev.map(v =>
        v.id === voiceId
          ? {
              ...v,
              provider_voice_id: providerVoiceIdForTest,
              is_verified: false,
              verification_status: 'pending',
              verification_selected_model: null,
            }
          : v
      ));

      setVerificationSamples({
        optionAUrl: optionAData.audioUrl,
        optionBUrl: optionBData.audioUrl,
        providerVoiceId: providerVoiceIdForTest,
      });

      toast.info('האזן לשתי הדגימות ובחר איזו נשמעת כמוך.');
    } catch (e: any) {
      toast.error(e.message || 'שגיאה ביצירת דגימות אימות A/B');
      setVerifyingVoiceId(null);
      setVerificationSamples(null);
    }
  };

  const confirmVerification = async (selectedModel: 'eleven_v3' | 'eleven_multilingual_v2' | 'reject') => {
    const voiceId = verifyingVoiceId;
    const samples = verificationSamples;
    if (!voiceId || !samples) return;

    const voice = voices.find(v => v.id === voiceId);
    const providerVoiceId = samples.providerVoiceId || voice?.provider_voice_id;
    if (!providerVoiceId) {
      toast.error('חסר provider_voice_id לשמירת אימות');
      return;
    }

    const approved = selectedModel !== 'reject';
    const sampleUrl = selectedModel === 'eleven_multilingual_v2' ? samples.optionBUrl : samples.optionAUrl;

    try {
      await supabase.functions.invoke('voice-manager', {
        body: {
          action: 'save_voice_verification',
          voice_id: voiceId,
          provider_voice_id: providerVoiceId,
          status: approved ? 'approved' : 'rejected',
          sample_audio_url: sampleUrl,
          selected_model: approved ? selectedModel : null,
        },
      });

      setVoices(prev => prev.map(v =>
        v.id === voiceId
          ? {
              ...v,
              provider_voice_id: providerVoiceId,
              is_verified: approved,
              verification_status: approved ? 'approved' : 'rejected',
              verification_sample_url: sampleUrl,
              verification_selected_model: approved ? selectedModel : null,
            }
          : v
      ));

      if (approved) {
        toast.success('✅ הקול אומת ונשמר מודל ברירת מחדל לקול זה.');
      } else {
        toast.warning('❌ הקול סומן כלא מאומת. יש לבצע איפוס ושכפול מחדש.');
      }
    } catch {
      toast.error('שגיאה בשמירת תוצאת האימות');
    } finally {
      setVerifyingVoiceId(null);
      setVerificationSamples(null);
    }
  };

  // ══════════════════════════════════════════
  // ── Script-to-Voice Flow ──
  // ══════════════════════════════════════════
  const selectedVoice = voices.find(v => v.id === selectedVoiceId);

  const parseGenerateError = async (error: any) => {
    const fallback = error?.message || 'שגיאה ביצירת דיבוב';
    const response = error?.context;
    if (!response || typeof response.text !== 'function') return { message: fallback, meta: null };
    try {
      const raw = await response.text();
      const parsed = raw ? JSON.parse(raw) : null;
      const providerError = parsed?.providerError
        ? (typeof parsed.providerError === 'string' ? parsed.providerError : JSON.stringify(parsed.providerError))
        : undefined;
      return {
        message: parsed?.warning || parsed?.error || fallback,
        meta: { functionName: parsed?.functionName, status: typeof response.status === 'number' ? response.status : undefined, providerError },
      };
    } catch {
      return { message: fallback, meta: { status: typeof response.status === 'number' ? response.status : undefined } };
    }
  };

  const openScriptToVoice = () => {
    setShowScriptToVoice(true);
    setGenerationError(null);
    setGenerationErrorMeta(null);
    setTechDetails(null);
    setShowTechDetails(false);
    if (!selectedVoiceId && voices.length > 0) setSelectedVoiceId(voices[0].id);
  };

  const currentVibeSettings = VIBE_PRESETS[vibePreset]?.settings || VIBE_PRESETS.default.settings;
  const selectedVoiceRequiresVerification = Boolean(selectedVoice && !selectedVoice.is_verified);

  const costEstimates: CostEstimate[] = [{
    provider: 'ElevenLabs',
    model: selectedVoice?.verification_selected_model || 'model from verification',
    action: 'קריינות (קול מאומת)',
    estimatedCost: `~${scriptText.length} תווים`,
    details: [
      'קול לא מאומת חסום ליצירת דיבוב',
      `פריסט: ${VIBE_PRESETS[vibePreset]?.label || 'רגיל'}`,
    ],
  }];

  const pendingVerifyVoice = voices.find(v => v.id === pendingVerifyVoiceId) || null;
  const verificationCostEstimates: CostEstimate[] = [
    {
      provider: 'ElevenLabs',
      model: 'eleven_v3 + he',
      action: pendingVerifyVoice?.provider_voice_id ? 'A/B אימות (ללא שכפול)' : 'A/B אימות + שכפול',
      estimatedCost: `~${VERIFICATION_TEST_SENTENCE.length * 2} תווים`,
      details: [
        pendingVerifyVoice?.provider_voice_id
          ? 'אפשרות A: eleven_v3 עם language_code=he'
          : 'אפשרות A: שכפול + eleven_v3 עם language_code=he',
      ],
    },
    {
      provider: 'ElevenLabs',
      model: 'eleven_multilingual_v2 (auto)',
      action: 'A/B אימות קול',
      estimatedCost: `~${VERIFICATION_TEST_SENTENCE.length} תווים`,
      details: ['אפשרות B: eleven_multilingual_v2 ללא language_code (auto-detect)'],
    },
  ];

  const handleRequestGenerate = () => {
    if (!selectedVoiceId) { toast.error('יש לבחור קול'); return; }
    if (!scriptText.trim()) { toast.error('יש להזין תסריט'); return; }
    if (scriptText.length > 4500) { toast.error('התסריט ארוך מדי (מקסימום 4,500 תווים)'); return; }
    if (!scriptTitle.trim()) { toast.error('יש להזין כותרת לדיבוב'); return; }
    if (!selectedVoice?.provider_voice_id || !selectedVoice.is_verified) {
      toast.error('הקול לא מאומת. לחץ "אמת את הקול" לפני יצירת דיבוב.');
      return;
    }

    setGenerationError(null);
    setGenerationErrorMeta(null);
    setCostApprovalOpen(true);
  };

  const executeGenerate = async () => {
    setCostApprovalOpen(false);
    if (!selectedVoice) return;
    if (!selectedVoice.provider_voice_id || !selectedVoice.is_verified) {
      toast.error('הקול לא מאומת. יש להשלים אימות תחילה.');
      return;
    }

    setGenerating(true);
    setGeneratedAudioUrl(null);
    setGenerationError(null);
    setGenerationErrorMeta(null);
    setTechDetails(null);

    try {
      const processedScript = respectPauses ? preprocessPauses(scriptText) : scriptText;
      const preferredModel = selectedVoice.verification_selected_model || 'eleven_v3';

      const body: Record<string, unknown> = {
        scriptText: processedScript,
        language,
        providerVoiceId: selectedVoice.provider_voice_id,
        voiceSettings: currentVibeSettings,
        modelId: preferredModel,
        omitLanguageCode: preferredModel === 'eleven_multilingual_v2',
      };

      const { data, error } = await supabase.functions.invoke('clone-voice-tts', { body });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (!data?.audioUrl) throw new Error('לא התקבל קובץ אודיו');

      setGeneratedAudioUrl(data.audioUrl);
      setGeneratedVoiceId(data.voiceId || null);

      setTechDetails({
        selectedVoiceId: selectedVoice.id,
        providerVoiceIdSent: selectedVoice.provider_voice_id,
        voiceIdReturned: data.voiceId || '',
        clonedFresh: data.clonedFresh || false,
        provider: 'ElevenLabs',
        modelId: data.modelId || preferredModel,
        language: data.language || '(auto)',
        voiceSettings: data.voiceSettings || currentVibeSettings,
        trainingAudioUrlUsed: data.trainingAudioUrlUsed ?? null,
        trainingAudioDurationSec: data.trainingAudioDurationSec ?? null,
        trainingAudioSizeBytes: data.trainingAudioSizeBytes ?? null,
        trainingAudioContentType: data.trainingAudioContentType ?? null,
        trainingAudioCodec: data.trainingAudioCodec ?? null,
      });

      if (data.warning) toast.warning(data.warning);
      toast.success('הדיבוב נוצר בהצלחה!');
    } catch (e: any) {
      console.error('TTS generation error:', e);
      const parsed = await parseGenerateError(e);
      setGenerationError(parsed.message);
      setGenerationErrorMeta(parsed.meta);
      toast.error(parsed.message || 'שגיאה ביצירת דיבוב');
    } finally {
      setGenerating(false);
    }
  };

  const handleDownloadMp3 = () => {
    if (!generatedAudioUrl) return;
    const a = document.createElement('a');
    a.href = generatedAudioUrl;
    a.download = `${scriptTitle || 'dubbing'}-${Date.now()}.mp3`;
    a.click();
  };

  const handleSaveGeneration = async () => {
    if (!generatedAudioUrl) return;
    setSavingGeneration(true);
    try {
      const { data, error } = await supabase.functions.invoke('voice-manager', {
        body: {
          action: 'save_generation',
          title: scriptTitle,
          script: scriptText,
          voice_id: selectedVoiceId,
          voice_name: selectedVoice?.name || '',
          provider: 'ElevenLabs',
          audio_url: generatedAudioUrl,
          provider_voice_id_used: techDetails?.voiceIdReturned || null,
          model_id_used: techDetails?.modelId || null,
          language_code_used: techDetails?.language || null,
          voice_settings_used: techDetails?.voiceSettings || null,
        },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      setGenerations(prev => [data.generation, ...prev]);
      toast.success('הדיבוב נשמר בספריית הקולות!');
      setShowScriptToVoice(false);
      setScriptText('');
      setScriptTitle('');
      setGeneratedAudioUrl(null);
      setGeneratedVoiceId(null);
      setGenerationError(null);
      setGenerationErrorMeta(null);
      setTechDetails(null);
    } catch (e: any) {
      toast.error(e.message || 'שגיאה בשמירה');
    } finally {
      setSavingGeneration(false);
    }
  };

  // ══════════════════════════════════════════
  // ── RENDER ──
  // ══════════════════════════════════════════
  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-rubik font-bold flex items-center gap-2">
              <Mic className="w-6 h-6 text-primary" />
              דיבוב / קול
            </h1>
            <p className="text-muted-foreground text-sm mt-1">הקלט קולות, העלה אודיו או צור דיבוב מתסריט</p>
          </div>
          <div className="flex gap-2">
            <button onClick={openScriptToVoice} className="bg-primary text-primary-foreground px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2">
              <FileText className="w-4 h-4" /> 💰 צור דיבוב
            </button>
            <button onClick={() => setCreating(true)} className="gradient-gold text-primary-foreground px-4 py-2 rounded-lg font-semibold text-sm flex items-center gap-2">
              <Plus className="w-4 h-4" /> הוסף קול חדש
            </button>
          </div>
        </div>

        {/* Recording quality guide */}
        {creating && (
          <div className="bg-warning/10 border border-warning/30 rounded-xl p-4 space-y-2">
            <p className="text-sm font-semibold flex items-center gap-2 text-warning">
              <AlertTriangle className="w-4 h-4" />
              הנחיות להקלטה איכותית (חשוב!)
            </p>
            <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
              <li><strong>אורך מינימלי: 30 שניות</strong> (מומלץ 60-120 שניות)</li>
              <li>חדר שקט, ללא מוזיקה או רעשי רקע</li>
              <li>דובר אחד בלבד, בקצב טבעי</li>
              <li>פורמט מומלץ: WAV או MP3 — <strong>לא WhatsApp OGG</strong></li>
              <li>הקלטות WhatsApp קצרות (&lt;10 שניות) יחסמו אוטומטית</li>
            </ul>
          </div>
        )}

        {/* Script-to-Voice Panel */}
        {showScriptToVoice && (
          <div className="bg-card border border-border rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg flex items-center gap-2">
                <FileText className="w-5 h-5 text-primary" />
                צור דיבוב מתסריט
              </h3>
              <button onClick={() => { setShowScriptToVoice(false); setGeneratedAudioUrl(null); setGenerationError(null); setGenerationErrorMeta(null); setTechDetails(null); }} className="p-1 hover:bg-muted rounded-lg">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Voice selector */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">בחר קול</label>
              {voices.length === 0 ? (
                <p className="text-sm text-destructive">אין קולות שמורים. הקלט או העלה קול קודם.</p>
              ) : (
                <select value={selectedVoiceId} onChange={e => setSelectedVoiceId(e.target.value)}
                  className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50">
                  <option value="">בחר קול...</option>
                  {voices.map(v => (
                    <option key={v.id} value={v.id}>
                      {v.name} ({v.type === 'recorded' ? '🎙️' : '📁'})
                      {v.is_verified ? ' ✅ מאומת' : v.provider_voice_id ? ' ⚠️ לא מאומת' : ''}
                    </option>
                  ))}
                </select>
              )}
              {selectedVoice?.is_verified && (
                <p className="text-xs text-primary mt-1">✅ קול מאומת — ניתן ליצור דיבוב</p>
              )}
              {selectedVoice && !selectedVoice.is_verified && (
                <p className="text-xs text-warning mt-1">⚠️ הקול לא מאומת — יצירת דיבוב חסומה עד אימות A/B.</p>
              )}
            </div>

            {/* Language */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">שפת הדיבוב</label>
              <select value={language} onChange={e => setLanguage(e.target.value as 'he' | 'en' | 'ar')}
                className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50">
                <option value="he">🇮🇱 עברית</option>
                <option value="en">🇺🇸 English</option>
                <option value="ar">🇸🇦 عربية</option>
              </select>
            </div>

            {/* Vibe */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">סגנון דיבור (Vibe)</label>
              <div className="flex flex-wrap gap-2">
                {Object.entries(VIBE_PRESETS).map(([key, preset]) => (
                  <button key={key} onClick={() => setVibePreset(key)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      vibePreset === key ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted/50 text-foreground border-border hover:bg-muted'
                    }`}>
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Pauses toggle */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-xs font-medium text-muted-foreground">כבד פסיקים ושורות</label>
                <p className="text-xs text-muted-foreground/70">שורות חדשות יהפכו להפסקות קצרות</p>
              </div>
              <button onClick={() => setRespectPauses(!respectPauses)}
                className={`relative w-11 h-6 rounded-full transition-colors ${respectPauses ? 'bg-primary' : 'bg-muted'}`}>
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${respectPauses ? 'right-0.5' : 'left-0.5'}`} />
              </button>
            </div>

            {/* Title */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">כותרת הדיבוב</label>
              <div className="flex gap-2">
                <input value={scriptTitle} onChange={e => setScriptTitle(e.target.value)} onKeyDown={e => e.stopPropagation()}
                  placeholder="למשל: פתיח סרטון מכירות"
                  className="flex-1 bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                <VoiceDictationButton onResult={text => setScriptTitle(prev => prev ? prev + ' ' + text : text)} />
              </div>
            </div>

            {/* Script */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                תסריט ({language === 'he' ? 'עברית' : language === 'ar' ? 'عربية' : 'English'}) — {scriptText.length}/4,500 תווים
              </label>
              <div className="relative">
                <textarea value={scriptText} onChange={e => setScriptText(e.target.value)} onKeyDown={e => e.stopPropagation()}
                  placeholder="הקלד את הטקסט שיוקרא בקול שלך..." rows={6} dir="rtl" maxLength={4500}
                  className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-y" />
                <div className="absolute bottom-2 left-2">
                  <VoiceDictationButton onResult={text => setScriptText(prev => prev ? prev + ' ' + text : text)} />
                </div>
              </div>
            </div>

            {generationError && (
              <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 space-y-2">
                <p className="text-sm font-medium text-destructive whitespace-pre-wrap">{generationError}</p>
                {(generationErrorMeta?.functionName || generationErrorMeta?.status) && (
                  <p className="text-xs text-muted-foreground">
                    פונקציה: {generationErrorMeta?.functionName || 'לא ידוע'}
                    {generationErrorMeta?.status ? ` • סטטוס: ${generationErrorMeta.status}` : ''}
                  </p>
                )}
                {generationErrorMeta?.providerError && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">פרטי שגיאה מהספק</summary>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words bg-background/70 border border-border rounded-md p-2">{generationErrorMeta.providerError}</pre>
                  </details>
                )}
              </div>
            )}

            {/* Generate button */}
            {!generatedAudioUrl && (
              <button onClick={handleRequestGenerate} disabled={generating || !selectedVoiceId || !scriptText.trim() || !scriptTitle.trim() || selectedVoiceRequiresVerification}
                className="w-full gradient-gold text-primary-foreground py-3 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50">
                {generating ? (<><Loader2 className="w-4 h-4 animate-spin" /> יוצר דיבוב... (עשוי לקחת 30-60 שניות)</>) : (<><DollarSign className="w-4 h-4" /> 💰 צור דיבוב</>)}
              </button>
            )}

            {/* Generated output */}
            {generatedAudioUrl && (
              <div className="bg-muted/30 border border-primary/30 rounded-xl p-4 space-y-3">
                <p className="text-sm font-semibold text-primary">✅ הדיבוב נוצר בהצלחה!</p>
                <div className="flex items-center gap-3 bg-background rounded-lg p-3 border border-border">
                  <button onClick={() => togglePlay('generated', generatedAudioUrl)}
                    className="w-10 h-10 gradient-gold text-primary-foreground rounded-full flex items-center justify-center">
                    {playingId === 'generated' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 mr-[-1px]" />}
                  </button>
                  <audio src={generatedAudioUrl} controls className="flex-1 h-8" onEnded={() => setPlayingId(null)} />
                </div>
                <div className="flex gap-2 flex-wrap">
                  <button onClick={handleDownloadMp3} className="px-4 py-2 border border-border rounded-lg text-xs hover:bg-muted flex items-center gap-1.5">
                    <Download className="w-3.5 h-3.5" /> הורד MP3
                  </button>
                  <button onClick={handleSaveGeneration} disabled={savingGeneration}
                    className="px-4 py-2 gradient-gold text-primary-foreground rounded-lg text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
                    {savingGeneration ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mic className="w-3.5 h-3.5" />}
                    שמור לספריית קולות
                  </button>
                </div>

                {/* Tech details */}
                {techDetails && (
                  <div className="mt-2">
                    <button onClick={() => setShowTechDetails(!showTechDetails)}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                      <Info className="w-3.5 h-3.5" /> פרטים טכניים
                      {showTechDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                    {showTechDetails && (
                      <div className="mt-2 bg-background border border-border rounded-lg p-3 text-xs space-y-1 font-mono" dir="ltr">
                        <p><span className="text-muted-foreground">selectedVoiceId:</span> {techDetails.selectedVoiceId}</p>
                        <p><span className="text-muted-foreground">providerVoiceId sent:</span> {techDetails.providerVoiceIdSent}</p>
                        <p><span className="text-muted-foreground">voiceId returned:</span> {techDetails.voiceIdReturned}</p>
                        <p><span className="text-muted-foreground">clonedFresh:</span> {techDetails.clonedFresh ? 'yes' : 'no (reused)'}</p>
                        <p><span className="text-muted-foreground">provider:</span> {techDetails.provider}</p>
                        <p><span className="text-muted-foreground">modelId:</span> {techDetails.modelId}</p>
                        <p><span className="text-muted-foreground">language_code:</span> {techDetails.language}</p>
                        <p><span className="text-muted-foreground">voice_settings:</span> {JSON.stringify(techDetails.voiceSettings)}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Create new voice */}
        {creating && (
          <div className="bg-card border border-border rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">קול חדש</h3>
              <button onClick={() => { setCreating(false); setName(''); }} className="p-1 hover:bg-muted rounded-lg">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">שם הקול</label>
              <div className="flex gap-2">
                <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.stopPropagation()}
                  placeholder="למשל: קול ראשי, קול מכירות" className="flex-1 bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                <VoiceDictationButton onResult={text => setName(prev => prev ? prev + ' ' + text : text)} />
              </div>
            </div>
            {saving && (
              <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> שומר קול...
              </div>
            )}
            {!saving && (
              <>
                <VoiceRecorder label="🎙️ הקלט קול (60 שניות מינימום)" onSaved={url => handleSaveVoice(url, 'recorded')} />
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" /> או העלה קובץ <span className="h-px flex-1 bg-border" /></div>
                <FileUploadZone accept="audio/*" label="העלה קובץ אודיו" hint="WAV, MP3, M4A (60 שניות+)"
                  onUploaded={url => { if (url) handleSaveVoice(url, 'uploaded'); }} />
              </>
            )}
          </div>
        )}

        {/* Loading */}
        {loading ? (
          <div className="text-center py-16 text-muted-foreground">
            <Loader2 className="w-8 h-8 mx-auto mb-4 animate-spin opacity-30" />
            <p className="text-sm">טוען קולות...</p>
          </div>
        ) : (
          <>
            {/* Generations History */}
            {generations.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <FileText className="w-5 h-5 text-primary" />
                  דיבובים שנוצרו
                </h2>
                {generations.map(gen => (
                  <div key={gen.id} className="bg-card border border-border rounded-xl p-4 space-y-2 group">
                    <div className="flex items-center gap-4">
                      <button onClick={() => togglePlay(gen.id, gen.audio_url)}
                        className="w-12 h-12 gradient-gold text-primary-foreground rounded-full flex items-center justify-center shadow-lg flex-shrink-0">
                        {playingId === gen.id ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 mr-[-2px]" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm">{gen.title}</p>
                        <p className="text-xs text-muted-foreground">
                          🎙️ {gen.voice_name || 'קול לא ידוע'} • {gen.provider} • {new Date(gen.created_at).toLocaleDateString('he-IL')}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => setExpandedGenId(expandedGenId === gen.id ? null : gen.id)}
                          className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-muted transition-colors" title="הצג פרטים">
                          {expandedGenId === gen.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                        <button onClick={() => { const a = document.createElement('a'); a.href = gen.audio_url; a.download = `${gen.title}.mp3`; a.click(); }}
                          className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-muted transition-colors" title="הורד MP3">
                          <Download className="w-4 h-4" />
                        </button>
                        <button onClick={() => handleDeleteGeneration(gen.id)}
                          className="w-8 h-8 bg-destructive/10 text-destructive rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    {expandedGenId === gen.id && (
                      <div className="bg-muted/30 rounded-lg p-3 space-y-2 text-sm">
                        <div>
                          <p className="text-xs font-medium text-muted-foreground mb-1">תסריט:</p>
                          <p className="text-foreground whitespace-pre-wrap" dir="rtl">{gen.script}</p>
                        </div>
                        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                          <span>קול: {gen.voice_name}</span>
                          <span>ספק: {gen.provider}</span>
                          {gen.duration_seconds && <span>אורך: {Math.round(gen.duration_seconds)} שניות</span>}
                        </div>
                        {/* Generation audit metadata */}
                        {(gen.provider_voice_id_used || gen.model_id_used) && (
                          <div className="bg-background border border-border rounded-lg p-2 text-xs font-mono space-y-0.5" dir="ltr">
                            {gen.provider_voice_id_used && <p><span className="text-muted-foreground">provider_voice_id:</span> {gen.provider_voice_id_used}</p>}
                            {gen.model_id_used && <p><span className="text-muted-foreground">model:</span> {gen.model_id_used}</p>}
                            {gen.language_code_used && <p><span className="text-muted-foreground">language:</span> {gen.language_code_used}</p>}
                            {gen.voice_settings_used && <p><span className="text-muted-foreground">settings:</span> {JSON.stringify(gen.voice_settings_used)}</p>}
                          </div>
                        )}
                        <audio src={gen.audio_url} controls className="w-full h-8" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Saved Voices */}
            <div className="space-y-3">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Mic className="w-5 h-5 text-primary" />
                קולות שמורים
              </h2>
              {voices.length === 0 && !creating ? (
                <div className="text-center py-16 text-muted-foreground">
                  <Mic className="w-16 h-16 mx-auto mb-4 opacity-30" />
                  <p className="text-lg font-medium">אין קולות שמורים עדיין</p>
                  <p className="text-sm mt-1">הקלט או העלה קול ראשון</p>
                </div>
              ) : (
                voices.map(voice => (
                  <div key={voice.id} className="bg-card border border-border rounded-xl overflow-hidden group">
                    <div className="p-4 flex items-center gap-4">
                      <button onClick={() => togglePlay(voice.id, voice.audio_url)}
                        className="w-12 h-12 gradient-gold text-primary-foreground rounded-full flex items-center justify-center shadow-lg flex-shrink-0">
                        {playingId === voice.id ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 mr-[-2px]" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm flex items-center gap-2">
                          {voice.name}
                          {voice.is_verified && <ShieldCheck className="w-4 h-4 text-green-500" />}
                          {voice.provider_voice_id && !voice.is_verified && <ShieldAlert className="w-4 h-4 text-warning" />}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {voice.type === 'recorded' ? '🎙️ הוקלט' : '📁 הועלה'} • {new Date(voice.created_at).toLocaleDateString('he-IL')}
                          {voice.is_verified ? ' • ✅ מאומת' : voice.provider_voice_id ? ' • ⚠️ לא מאומת' : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        {/* Expand / audit */}
                        <button onClick={() => setExpandedVoiceId(expandedVoiceId === voice.id ? null : voice.id)}
                          className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-muted transition-colors" title="פרטים ואימות">
                          <Info className="w-4 h-4" />
                        </button>
                        <button onClick={() => handleDelete(voice.id)}
                          className="w-8 h-8 bg-destructive/10 text-destructive rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Expanded audit + actions */}
                    {expandedVoiceId === voice.id && (
                      <div className="border-t border-border bg-muted/20 p-4 space-y-3">
                        {/* Audit info */}
                        <div className="bg-background border border-border rounded-lg p-3 text-xs space-y-1 font-mono" dir="ltr">
                          <p><span className="text-muted-foreground">voice_id (DB):</span> {voice.id}</p>
                          <p><span className="text-muted-foreground">provider_voice_id:</span> {voice.provider_voice_id || '(not cloned yet)'}</p>
                          <p><span className="text-muted-foreground">selected_model:</span> {voice.verification_selected_model || '(not selected yet)'}</p>
                          <p><span className="text-muted-foreground">training_file:</span> {voice.training_audio_file_name || '—'}</p>
                          <p><span className="text-muted-foreground">training_url:</span> {voice.audio_url}</p>
                          <p><span className="text-muted-foreground">training_size_bytes:</span> {trainingAuditByVoiceId[voice.id]?.sizeBytes ?? 'unknown'}</p>
                          <p><span className="text-muted-foreground">training_duration_sec:</span> {trainingAuditByVoiceId[voice.id]?.durationSec ? trainingAuditByVoiceId[voice.id].durationSec!.toFixed(2) : 'unknown'}</p>
                          <p><span className="text-muted-foreground">training_content_type:</span> {trainingAuditByVoiceId[voice.id]?.contentType || 'unknown'}</p>
                          <p><span className="text-muted-foreground">training_codec:</span> {trainingAuditByVoiceId[voice.id]?.codec || 'unknown'}</p>
                          <p><span className="text-muted-foreground">created_at:</span> {voice.created_at}</p>
                          <p><span className="text-muted-foreground">verification:</span> {voice.verification_status || 'unverified'}</p>
                          {voice.verification_updated_at && (
                            <p><span className="text-muted-foreground">verified_at:</span> {voice.verification_updated_at}</p>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => togglePlay(`training-${voice.id}`, voice.audio_url)}
                            className="px-3 py-1.5 border border-border rounded-lg text-xs font-medium flex items-center gap-1.5 hover:bg-muted"
                          >
                            <Play className="w-3.5 h-3.5" /> נגן קובץ אימון
                          </button>
                        </div>

                        {/* Verification sample playback */}
                        {voice.verification_sample_url && (
                          <div className="space-y-1">
                            <p className="text-xs font-medium text-muted-foreground">דגימת אימות אחרונה:</p>
                            <audio src={voice.verification_sample_url} controls className="w-full h-8" />
                          </div>
                        )}

                        {/* Action buttons */}
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => handleResetVoice(voice.id)}
                            disabled={resettingVoiceId === voice.id}
                            className="px-3 py-1.5 border border-destructive/50 text-destructive rounded-lg text-xs font-medium flex items-center gap-1.5 hover:bg-destructive/10 disabled:opacity-50"
                          >
                            {resettingVoiceId === voice.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                            איפוס ושכפול מחדש
                          </button>

                          {!voice.is_verified && (
                            <button
                              onClick={() => requestVerification(voice.id)}
                              disabled={verifyingVoiceId === voice.id}
                              className="px-3 py-1.5 border border-primary/50 text-primary rounded-lg text-xs font-medium flex items-center gap-1.5 hover:bg-primary/10 disabled:opacity-50"
                            >
                              {verifyingVoiceId === voice.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                              💰 אמת את הקול (A/B)
                            </button>
                          )}
                        </div>

                        {/* Active verification flow */}
                        {verifyingVoiceId === voice.id && verificationSamples && (
                          <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 space-y-3">
                            <p className="text-sm font-semibold text-primary">🔊 אימות A/B — אותו משפט, אותו provider_voice_id</p>
                            <p className="text-xs text-muted-foreground">"{VERIFICATION_TEST_SENTENCE}"</p>

                            <div className="space-y-2">
                              <p className="text-xs font-medium">A: eleven_v3 + he</p>
                              <audio src={verificationSamples.optionAUrl} controls className="w-full h-8" />
                            </div>

                            <div className="space-y-2">
                              <p className="text-xs font-medium">B: eleven_multilingual_v2 (auto)</p>
                              <audio src={verificationSamples.optionBUrl} controls className="w-full h-8" />
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                              <button
                                onClick={() => confirmVerification('eleven_v3')}
                                className="px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold"
                              >
                                לבחור A (נשמע כמוני)
                              </button>
                              <button
                                onClick={() => confirmVerification('eleven_multilingual_v2')}
                                className="px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-semibold"
                              >
                                לבחור B (נשמע כמוני)
                              </button>
                              <button
                                onClick={() => confirmVerification('reject')}
                                className="px-3 py-2 bg-destructive text-destructive-foreground rounded-lg text-sm font-semibold"
                              >
                                אף אחד מהם
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {/* Cost Approval Dialogs */}
      <CostApprovalDialog open={costApprovalOpen} onOpenChange={setCostApprovalOpen}
        estimates={costEstimates} onApprove={executeGenerate} title="אישור יצירת דיבוב" />

      <CostApprovalDialog open={verificationCostOpen} onOpenChange={setVerificationCostOpen}
        estimates={verificationCostEstimates} onApprove={executeVerification} title="אישור דגימת אימות קול" />
    </AppLayout>
  );
}
