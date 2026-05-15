import { useState, useRef, useCallback, useEffect } from 'react';
import {
  ArrowRight, Loader2, Download, Copy, RefreshCw, Plus,
  Play, Pause, Mic, MicOff, Upload, Eye, Save, Edit3,
  Subtitles, Check, X, Wand2, UserCircle, ChevronLeft,
  ImageIcon, Video, FileText, Sparkles, Link2, Volume2, ChevronDown, Scissors, Layers, PictureInPicture2
} from 'lucide-react';
import { VoiceDictationButton } from '@/components/VoiceDictationButton';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useSpeechToText } from '@/hooks/use-speech-to-text';
import {
  imageService, voiceService, didService, avatarGenService,
  promptEnhanceService, subtitleService, runwayService,
  avatarDbService, storageService, composeService, soundEffectService, kreaService,
  importService, type ImportResult,
  type SubtitleSegment, type Brand, brandService,
} from '@/services/creativeService';
import { projectService } from '@/services/projectService';
import { supabase } from '@/integrations/supabase/client';
import { FileUploadZone } from '@/components/FileUploadZone';
import { VoiceRecorder } from '@/components/VoiceRecorder';
import { UrlImportInput } from '@/components/UrlImportInput';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { VideoWizardFlow, type VideoWizardSession } from '@/components/studio/VideoWizardFlow';
import { CostApprovalDialog, buildHighlightEstimates, type CostEstimate } from '@/components/studio/CostApprovalDialog';
import { SubtitleEditor } from '@/components/studio/SubtitleEditor';
import { WebsiteScanPanel, type WebsiteScanResult } from '@/components/studio/WebsiteScanPanel';
import { CarouselGenerator } from '@/components/studio/CarouselGenerator';
import { HighlightWizardFlow } from '@/components/studio/HighlightWizardFlow';

export type StudioAction = 'image' | 'video_ai' | 'subtitles' | 'import_edit' | 'highlight';

const actionOptions: { id: StudioAction; label: string; icon: typeof ImageIcon; desc: string }[] = [
  { id: 'image', label: 'צור תמונה', icon: ImageIcon, desc: 'יצירת תמונה שיווקית מתיאור טקסט' },
  { id: 'video_ai', label: 'וידאו AI', icon: Video, desc: 'צור סרטון מתמונה או טקסט' },
  { id: 'subtitles', label: 'כתוביות לסרטון', icon: Subtitles, desc: 'תמלול אוטומטי + עריכת כתוביות' },
  { id: 'import_edit', label: 'ייבוא ועריכה', icon: Link2, desc: 'ייבוא תמונה או סרטון מקישור ישיר — עריכה וייצוא' },
  { id: 'highlight', label: 'סרטון קצר מתוכן ארוך', icon: Scissors, desc: 'העלה סרטונים ותמונות — קבל סרטון ויראלי 30-60 שניות' },
];

const subtitleFontOptions = [
  { value: 'font-heebo', label: 'Heebo (ברירת מחדל)' },
  { value: 'font-rubik', label: 'Rubik' },
  { value: 'font-sans', label: 'Sans' },
  { value: 'font-serif', label: 'Serif' },
  { value: 'font-mono', label: 'Mono' },
] as const;

interface StudioWizardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeBrand: Brand | undefined;
  activeBrandId: string | null;
  buildPrompt: (base: string) => string;
  initialCategory?: string;
}

export function StudioWizardDialog({ open, onOpenChange, activeBrand, activeBrandId, buildPrompt, initialCategory = '' }: StudioWizardDialogProps) {
  const [selectedAction, setSelectedAction] = useState<StudioAction | null>(null);
  const [step, setStep] = useState(0);

  // Shared state
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ imageUrl?: string; audioUrl?: string; videoUrl?: string } | null>(null);

  // Speech
  const { isListening, isSupported: speechSupported, toggle: toggleSpeech } = useSpeechToText({
    language: 'he-IL',
    onResult: (text) => setPrompt(prev => prev ? `${prev} ${text}` : text),
  });

  const MAX_REF_IMAGES = 7;

  // Image generation - reference images & iterative editing
  const [imageRefPhotos, setImageRefPhotos] = useState<string[]>([]);
  const [editHistory, setEditHistory] = useState<{ imageUrl: string; prompt: string; refineRefs?: string[] }[]>([]);
  const [editPrompt, setEditPrompt] = useState('');
  const [editRefPhotos, setEditRefPhotos] = useState<string[]>([]);
  const [uploadingEditRef, setUploadingEditRef] = useState(false);
  const editRefInputRef = useRef<HTMLInputElement | null>(null);
  const MAX_EDIT_REFS = 5;

  // Import/Edit
  const [importUrl, setImportUrl] = useState('');
  const [importType, setImportType] = useState<'image' | 'video' | null>(null);
  const [importStorageUrl, setImportStorageUrl] = useState(''); // The public URL saved in storage
  const [importLoading, setImportLoading] = useState(false);
  const [importStage, setImportStage] = useState('');
  const [importVideoEditMode, setImportVideoEditMode] = useState<'subtitles' | 'edit' | null>(null);
  const [importPipAvatar, setImportPipAvatar] = useState(false); // PiP avatar overlay

  // Video AI
  const [runwayMode, setRunwayMode] = useState<'image_to_video' | 'text_to_video'>('image_to_video');
  const [runwayImageUrl, setRunwayImageUrl] = useState('');
  const [runwayPolling, setRunwayPolling] = useState(false);
  const [runwayProgress, setRunwayProgress] = useState(0);

  // Subtitles
  const [subtitleSegments, setSubtitleSegments] = useState<SubtitleSegment[]>([]);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [currentSubtitle, setCurrentSubtitle] = useState('');
  const [savingSrt, setSavingSrt] = useState(false);
  const [savedSrtUrl, setSavedSrtUrl] = useState<string | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const [subtitleOffset, setSubtitleOffset] = useState(0.3);
  const [subtitleFontClass, setSubtitleFontClass] = useState<string>('font-heebo');

  // Highlight (long → short/long edited video)
  const [highlightFiles, setHighlightFiles] = useState<string[]>([]);
  const [highlightProgress, setHighlightProgress] = useState(0);
  const [highlightStage, setHighlightStage] = useState('');
  const [highlightOutputType, setHighlightOutputType] = useState<string>('viral_short');
  interface SavedAvatar { id: string; name: string; image_url: string; style: string; }
  interface SavedVoice {
    id: string;
    name: string;
    audio_url: string;
    type: string;
    provider_voice_id?: string | null;
    is_verified?: boolean;
    verification_status?: string;
  }
  const [availableAvatars, setAvailableAvatars] = useState<SavedAvatar[]>([]);
  const [availableVoices, setAvailableVoices] = useState<SavedVoice[]>([]);
  const [selectedAvatarId, setSelectedAvatarId] = useState<string | null>(null);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);
  const [showAvatarVoicePanel, setShowAvatarVoicePanel] = useState(false);
  const [savingOutput, setSavingOutput] = useState(false);

  // Cost approval gate for highlight flow
  const [showHighlightCostApproval, setShowHighlightCostApproval] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [customCategory, setCustomCategory] = useState<string>('');

  // Website scan state
  const [websiteScanResult, setWebsiteScanResult] = useState<WebsiteScanResult | null>(null);
  const [websiteContentForPrompt, setWebsiteContentForPrompt] = useState<{
    headline?: string; subheadline?: string; bullets?: string[];
    cta?: string; keywords?: string[]; brandColors?: string[]; logoUrl?: string;
  } | null>(null);

  // Carousel mode state
  const [imageMode, setImageMode] = useState<'single' | 'carousel'>('single');
  const [showCarousel, setShowCarousel] = useState(false);

  // Image aspect ratio
  const [imageAspectRatio, setImageAspectRatio] = useState<string>('auto');

  const brandDepartments = activeBrand?.departments || [];
  const effectiveCategory = customCategory.trim() || selectedCategory;

  // Inline brand selector state (for result view when no brand pre-selected)
  const [inlineBrandId, setInlineBrandId] = useState<string | null>(null);
  const [inlineNewBrandName, setInlineNewBrandName] = useState('');
  const brands = brandService.getAll();

  const handleSaveToProject = async () => {
    const brandId = activeBrandId || inlineBrandId;
    const brandObj = activeBrand || brands.find(b => b.id === inlineBrandId);
    if (!brandId || !brandObj) {
      toast.error('יש לבחור חברה / מותג לפני השמירה');
      return;
    }
    if (brandDepartments.length > 0 && !effectiveCategory) {
      toast.error('יש לבחור או להזין תת-פעילות לפני השמירה');
      return;
    }
    const url = result?.imageUrl || result?.videoUrl;
    if (!url) return;

    setSavingOutput(true);
    try {
      // Upload base64 data URLs to storage first
      let finalUrl = url;
      if (url.startsWith('data:')) {
        toast.info('מעלה קובץ לאחסון...');
        const blob = await fetch(url).then(r => r.blob());
        const isVid = !!result?.videoUrl || blob.type.startsWith('video/');
        const ext = isVid ? 'mp4' : url.includes('png') ? 'png' : 'jpg';
        const file = new File([blob], `output-${Date.now()}.${ext}`, { type: blob.type });
        finalUrl = await storageService.upload(file);
      }

      const cat = effectiveCategory || undefined;
      const project = await projectService.findOrCreateByBrand(brandId, brandObj.name, cat);
      const isVideo = !!result?.videoUrl;
      await projectService.addOutput(project.id, {
        name: `${selectedAction === 'image' ? 'תמונה' : selectedAction === 'video_ai' ? 'סרטון' : 'תוצר'} — ${brandObj.name}${cat ? ` — ${cat}` : ''}`,
        description: prompt || undefined,
        video_url: isVideo ? finalUrl : null,
        thumbnail_url: !isVideo ? finalUrl : null,
        prompt: prompt || null,
      });
      toast.success(`נשמר בפרויקט "${brandObj.name}${cat ? ` — ${cat}` : ''}"!`);
      clearSession();
    } catch (e: any) {
      toast.error(e.message || 'שגיאה בשמירה');
    } finally {
      setSavingOutput(false);
    }
  };

  // Load avatars & voices when dialog opens
  useEffect(() => {
    if (open) {
      avatarDbService.list().then(list => setAvailableAvatars(list)).catch(() => {});
      supabase.functions.invoke('voice-manager', { body: { action: 'list' } })
        .then(({ data }) => {
          if (data?.voices) setAvailableVoices(data.voices);
        })
        .catch(() => {});
    }
  }, [open]);

  // Sync selected category from current project context
  useEffect(() => {
    if (!open) return;
    setSelectedCategory(initialCategory || '');
    setCustomCategory('');
  }, [open, initialCategory]);

  // Session persistence key
  const SESSION_KEY = 'studio_wizard_session';

  // Video wizard sub-session (stored separately due to size)
  const VIDEO_SESSION_KEY = 'studio_video_wizard_session';
  const [videoWizardSession, setVideoWizardSession] = useState<VideoWizardSession | null>(null);

  // Save session to localStorage on meaningful state changes
  useEffect(() => {
    if (!open) return;
    if (step === 0 && !selectedAction) return; // Don't save initial state
    const session = {
      selectedAction, step, prompt, result, imageRefPhotos, editHistory, editPrompt,
      importUrl, importType, importStorageUrl, selectedAvatarId, selectedVoiceId,
      selectedCategory, customCategory, highlightFiles, highlightOutputType,
      timestamp: Date.now(),
    };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {
      // localStorage might be full — try removing large data URLs
      try {
        const lite = { ...session, result: null, imageRefPhotos: [], editHistory: [] };
        localStorage.setItem(SESSION_KEY, JSON.stringify(lite));
      } catch {}
    }
  }, [open, selectedAction, step, prompt, result, imageRefPhotos, editHistory, editPrompt, importUrl, importType, importStorageUrl, selectedAvatarId, selectedVoiceId, selectedCategory, customCategory, highlightFiles, highlightOutputType]);

  // Restore session when dialog opens
  const [sessionRestoreOffered, setSessionRestoreOffered] = useState(false);
  const [hasPendingSession, setHasPendingSession] = useState(false);

  useEffect(() => {
    if (!open) return;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const session = JSON.parse(raw);
      // Only offer restore if session is less than 24h old and has content
      if (Date.now() - session.timestamp > 86400000) { localStorage.removeItem(SESSION_KEY); return; }
      if (session.selectedAction || session.prompt || session.result) {
        setHasPendingSession(true);
      }
    } catch { localStorage.removeItem(SESSION_KEY); }
  }, [open]);

  const restoreSession = () => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.selectedAction) setSelectedAction(s.selectedAction);
      if (s.step) setStep(s.step);
      if (s.prompt) setPrompt(s.prompt);
      if (s.result) setResult(s.result);
      if (s.imageRefPhotos) setImageRefPhotos(s.imageRefPhotos);
      if (s.editHistory) setEditHistory(s.editHistory);
      if (s.editPrompt) setEditPrompt(s.editPrompt);
      if (s.importUrl) setImportUrl(s.importUrl);
      if (s.importType) setImportType(s.importType);
      if (s.importStorageUrl) setImportStorageUrl(s.importStorageUrl);
      if (s.selectedAvatarId) setSelectedAvatarId(s.selectedAvatarId);
      if (s.selectedVoiceId) setSelectedVoiceId(s.selectedVoiceId);
      if (s.selectedCategory) setSelectedCategory(s.selectedCategory);
      if (s.customCategory) setCustomCategory(s.customCategory);
      if (s.highlightFiles) setHighlightFiles(s.highlightFiles);
      if (s.highlightOutputType) setHighlightOutputType(s.highlightOutputType);
      // Restore video wizard sub-session
      if (s.selectedAction === 'video_ai') {
        try {
          const videoRaw = localStorage.getItem(VIDEO_SESSION_KEY);
          if (videoRaw) setVideoWizardSession(JSON.parse(videoRaw));
        } catch {}
      }
      toast.success('הסשן שוחזר בהצלחה!');
    } catch {}
    setHasPendingSession(false);
    setSessionRestoreOffered(true);
  };

  const dismissSession = () => {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(VIDEO_SESSION_KEY);
    setVideoWizardSession(null);
    setHasPendingSession(false);
    setSessionRestoreOffered(true);
  };

  const clearSession = () => {
    try { localStorage.removeItem(SESSION_KEY); } catch {}
    try { localStorage.removeItem(VIDEO_SESSION_KEY); } catch {}
    setVideoWizardSession(null);
  };

  // Reset when dialog closes — but don't clear session (only clear on explicit "start fresh")
  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setSelectedAction(null);
        setStep(0);
        setPrompt('');
        setResult(null);
        setImageRefPhotos([]);
        setEditHistory([]);
        setEditPrompt('');
        setEditRefPhotos([]);
        setImportUrl('');
        setImportType(null);
        setImportStorageUrl('');
        setImportVideoEditMode(null);
        setImportPipAvatar(false);
        setRunwayImageUrl('');
        setVideoFile(null);
        setVideoPreviewUrl(null);
        setSubtitleSegments([]);
        setSavedSrtUrl(null);
        setSelectedAvatarId(null);
        setSelectedVoiceId(null);
        setShowAvatarVoicePanel(false);
        setSelectedCategory('');
        setCustomCategory('');
        setSessionRestoreOffered(false);
        setHasPendingSession(false);
        setHighlightFiles([]);
        setHighlightProgress(0);
        setHighlightStage('');
        setHighlightOutputType('viral_short');
        setVideoWizardSession(null);
        setWebsiteScanResult(null);
        setWebsiteContentForPrompt(null);
        setImageMode('single');
        setShowCarousel(false);
      }, 300);
    }
  }, [open]);

  const selectedAvatar = availableAvatars.find(a => a.id === selectedAvatarId);
  const selectedVoice = availableVoices.find(v => v.id === selectedVoiceId);

  // ============ AVATAR & VOICE SELECTOR ============
  const renderAvatarVoiceSelector = () => {
    if (availableAvatars.length === 0 && availableVoices.length === 0) return null;
    return (
      <div className="border border-border rounded-xl overflow-hidden mb-4">
        <button
          onClick={() => setShowAvatarVoicePanel(!showAvatarVoicePanel)}
          className="w-full flex items-center justify-between px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-2 text-muted-foreground">
            <ChevronDown className={cn('w-4 h-4 transition-transform', showAvatarVoicePanel && 'rotate-180')} />
            <span>אווטאר וקול</span>
          </div>
          <div className="flex items-center gap-2">
            {selectedAvatar && (
              <span className="flex items-center gap-1.5 text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                <img src={selectedAvatar.image_url} alt="" className="w-4 h-4 rounded-full object-cover" />
                {selectedAvatar.name}
              </span>
            )}
            {selectedVoice && (
              <span className="flex items-center gap-1.5 text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                <Volume2 className="w-3 h-3" />
                {selectedVoice.name}
              </span>
            )}
          </div>
        </button>
        {showAvatarVoicePanel && (
          <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
            {availableAvatars.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                  <UserCircle className="w-3.5 h-3.5" /> בחר אווטאר
                </p>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  <button
                    onClick={() => setSelectedAvatarId(null)}
                    className={cn('flex-shrink-0 w-14 h-14 rounded-lg border-2 flex items-center justify-center transition-all text-xs text-muted-foreground',
                      !selectedAvatarId ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/30')}
                  >
                    ללא
                  </button>
                  {availableAvatars.map(avatar => (
                    <button
                      key={avatar.id}
                      onClick={() => setSelectedAvatarId(avatar.id === selectedAvatarId ? null : avatar.id)}
                      className={cn('flex-shrink-0 w-14 h-14 rounded-lg border-2 overflow-hidden transition-all',
                        selectedAvatarId === avatar.id ? 'border-primary shadow-gold' : 'border-border hover:border-primary/30')}
                      title={avatar.name}
                    >
                      <img src={avatar.image_url} alt={avatar.name} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
                {selectedAvatar && <p className="text-xs text-primary mt-1">{selectedAvatar.name}</p>}
              </div>
            )}
            {availableVoices.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Volume2 className="w-3.5 h-3.5" /> בחר קול
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setSelectedVoiceId(null)}
                    className={cn('px-3 py-1.5 rounded-lg border text-xs transition-all',
                      !selectedVoiceId ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-primary/30 text-muted-foreground')}
                  >
                    ברירת מחדל
                  </button>
                  {availableVoices.map(voice => (
                    <button
                      key={voice.id}
                      onClick={() => setSelectedVoiceId(voice.id === selectedVoiceId ? null : voice.id)}
                      className={cn('px-3 py-1.5 rounded-lg border text-xs transition-all flex items-center gap-1.5',
                        selectedVoiceId === voice.id ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-primary/30 text-muted-foreground')}
                    >
                      <Volume2 className="w-3 h-3" />
                      {voice.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const getAdjustedSegments = useCallback(() => {
    return subtitleSegments
      .map((seg) => ({
        ...seg,
        start: Math.max(0, Number((seg.start + subtitleOffset).toFixed(2))),
        end: Math.max(Math.max(0, Number((seg.start + subtitleOffset).toFixed(2))) + 0.1, Number((seg.end + subtitleOffset).toFixed(2))),
      }))
      .sort((a, b) => a.start - b.start);
  }, [subtitleSegments, subtitleOffset]);

  const handleDownload = async () => {
    const url = result?.imageUrl || result?.audioUrl || result?.videoUrl;
    if (!url) return;
    const ext = result?.videoUrl ? 'mp4' : result?.audioUrl ? 'mp3' : 'png';
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `${activeBrand?.name || 'studio'}-${Date.now()}.${ext}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
      toast.success('ההורדה החלה');
    } catch { window.open(url, '_blank'); }
  };

  const handleBack = () => {
    if (step > 1) setStep(step - 1);
    else if (step === 1) { setSelectedAction(null); setStep(0); }
    else onOpenChange(false);
  };

  const getStepInfo = () => {
    if (step === 0) return { title: 'מה תרצה ליצור?', desc: 'בחר את סוג התוכן שתרצה לייצר' };
    if (!selectedAction) return { title: '', desc: '' };

    const stepsMap: Record<StudioAction, { title: string; desc: string }[]> = {
      image: [
        { title: 'תאר את התמונה', desc: 'כתוב מה תרצה לראות בתמונה' },
        { title: 'התוצאה', desc: 'התמונה שנוצרה' },
      ],
      video_ai: [
        { title: 'יצירת סרטון מקצועי', desc: 'תאר, בחר אווטארים וקולות, אשר תסריט ותייצר' },
      ],
      subtitles: [
        { title: 'כתוביות וסטודיו', desc: 'תמלול, עיצוב, מוזיקה והרכבה' },
      ],
      import_edit: [
        { title: 'הדבק קישור', desc: 'שים קישור לתמונה או סרטון' },
        { title: importType === 'video' ? 'תצוגה ועריכה' : 'מה לשנות?', desc: importType === 'video' ? 'צפה בסרטון ובחר פעולות' : 'תאר את השינויים שתרצה' },
        { title: importType === 'video' ? 'עורך וידאו' : 'התוצאה', desc: importType === 'video' ? 'כתוביות, לוגו ועריכה' : 'התוצאה הערוכה' },
        { title: 'התוצאה', desc: 'התוצאה הערוכה' },
      ],
      highlight: [
        { title: 'סרטון קצר מתוכן ארוך', desc: 'העלה, הגדר ורנדר' },
      ],
    };

    const steps = stepsMap[selectedAction];
    const idx = step - 1;
    return steps[idx] || { title: '', desc: '' };
  };

  const getTotalSteps = () => {
    if (!selectedAction) return 1;
    const counts: Record<StudioAction, number> = {
      image: 2, video_ai: 1, subtitles: 1,
      import_edit: importType === 'video' ? 4 : 3,
      highlight: 1,
    };
    return counts[selectedAction] + 1;
  };

  // ============ PROMPT INPUT WITH SPEECH ============
  const renderPromptInput = ({ placeholder, rows = 4 }: { placeholder: string; rows?: number }) => (
    <div className="relative">
      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        onKeyDown={e => e.stopPropagation()}
        placeholder={placeholder}
        rows={rows}
        dir="rtl"
        className="w-full bg-muted/50 border border-border rounded-lg px-4 py-3 pl-12 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
      />
      {speechSupported && (
        <button
          type="button"
          onClick={toggleSpeech}
          className={cn(
            'absolute left-3 top-3 p-1.5 rounded-lg transition-all',
            isListening ? 'bg-destructive/10 text-destructive animate-pulse' : 'bg-muted/50 text-muted-foreground hover:text-foreground'
          )}
        >
          {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </button>
      )}
      {isListening && (
        <div className="absolute left-3 bottom-3 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
          <span className="text-xs text-destructive font-medium">מקליט...</span>
        </div>
      )}
    </div>
  );

  const renderCategorySelector = () => (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-muted-foreground">תת-פעילות / קטגוריה לפרויקט</label>
      {brandDepartments.length > 0 && (
        <select
          value={selectedCategory}
          onChange={e => setSelectedCategory(e.target.value)}
          className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          dir="rtl"
        >
          <option value="">בחר תת-פעילות...</option>
          {brandDepartments.map(d => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      )}
      <input
        value={customCategory}
        onChange={e => setCustomCategory(e.target.value)}
        placeholder="או כתוב תת-פעילות חדשה (למשל: הערכת שווי)"
        className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
        dir="rtl"
      />
    </div>
  );

  // Helper: delete a single history item
  const handleDeleteHistoryItem = (index: number) => {
    setEditHistory(prev => {
      const updated = prev.filter((_, i) => i !== index);
      // If current result was deleted, switch to last remaining or clear
      if (prev[index]?.imageUrl === result?.imageUrl) {
        if (updated.length > 0) setResult({ imageUrl: updated[updated.length - 1].imageUrl });
        else { setResult(null); setStep(step > 1 ? step - 1 : 0); }
      }
      return updated;
    });
    toast.success('הפריט נמחק מההיסטוריה');
  };


  // Helper: render inline brand selector for result view (when no brand selected)

  const effectiveBrandId = activeBrandId || inlineBrandId;
  const effectiveBrandObj = activeBrand || brands.find(b => b.id === inlineBrandId);

  const renderInlineBrandSelector = () => {
    if (activeBrand) return renderCategorySelector();
    return (
      <div className="bg-muted/30 border border-border rounded-xl p-3 space-y-2">
        <label className="block text-xs font-medium text-muted-foreground">שם חברה / מותג (לשמירה)</label>
        <select
          value={inlineBrandId || ''}
          onChange={e => setInlineBrandId(e.target.value || null)}
          className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          dir="rtl"
        >
          <option value="">בחר חברה...</option>
          {brands.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <div className="flex gap-2">
          <input
            value={inlineNewBrandName}
            onChange={e => setInlineNewBrandName(e.target.value)}
            placeholder="או הוסף חברה חדשה..."
            className="flex-1 bg-card border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            dir="rtl"
          />
          {inlineNewBrandName.trim() && (
            <button onClick={() => {
              const brand: Brand = {
                id: crypto.randomUUID(), name: inlineNewBrandName.trim(),
                tone: '', targetAudience: '', industry: '', colors: [], departments: [],
              };
              brandService.add(brand);
              setInlineBrandId(brand.id);
              setInlineNewBrandName('');
              toast.success(`"${brand.name}" נוצר`);
            }} className="px-3 py-2 gradient-gold text-primary-foreground rounded-lg text-xs font-semibold">
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  };


  // ============ RESULT VIEW ============
  const isResultVideo = !!(result?.videoUrl);
  const isResultImage = !!(result?.imageUrl) && !isResultVideo;
  const renderResultView = () => (
    <div className="space-y-4">
      {isResultImage && (
        <div className="rounded-lg overflow-hidden border border-border bg-muted/30 flex items-center justify-center">
          <img src={result!.imageUrl} alt="תוצאה" className="max-w-full max-h-[300px] object-contain" />
        </div>
      )}
      {isResultVideo && (
        <div className="rounded-lg overflow-hidden border border-border bg-muted/30">
          <video src={result!.videoUrl} controls className="w-full max-h-[300px]" />
        </div>
      )}
      {renderInlineBrandSelector()}
      <div className="flex gap-2">
        <button onClick={handleDownload} className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm hover:bg-muted flex items-center justify-center gap-2">
          <Download className="w-4 h-4" /> {isResultVideo ? 'הורד MP4' : 'הורד תמונה'}
        </button>
        <button onClick={handleSaveToProject} disabled={savingOutput}
          className="flex-1 px-4 py-2.5 gradient-gold text-primary-foreground rounded-lg text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50">
          {savingOutput ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {savingOutput ? 'שומר...' : 'שמור'}
        </button>
      </div>
      <button onClick={() => { clearSession(); setResult(null); setSelectedAction(null); setStep(0); setPrompt(''); setEditHistory([]); setEditPrompt(''); setImageRefPhotos([]); setSelectedCategory(initialCategory || ''); setCustomCategory(''); }}
        className="w-full text-sm text-muted-foreground hover:text-foreground flex items-center justify-center gap-1 py-2">
        <RefreshCw className="w-3.5 h-3.5" /> התחל מחדש
      </button>
    </div>
  );

  // ============ IMAGE RESULT WITH ITERATIVE EDITING ============
  const renderImageResultWithEdit = () => (
    <div className="space-y-4">
      {editHistory.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {editHistory.map((h, i) => (
            <div key={i} className="relative group flex-shrink-0">
              <button onClick={() => setResult({ imageUrl: h.imageUrl })}
                className={cn('w-16 h-16 rounded-lg overflow-hidden border-2 transition-all',
                  result?.imageUrl === h.imageUrl ? 'border-primary shadow-gold' : 'border-border/50 opacity-60 hover:opacity-100')}>
                <img src={h.imageUrl} alt={`גרסה ${i + 1}`} className="w-full h-full object-cover" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleDeleteHistoryItem(i); }}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                title="מחק"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {result?.imageUrl && (
        <div className="rounded-lg overflow-hidden border border-border bg-muted/30 flex items-center justify-center">
          <img src={result.imageUrl} alt="תוצאה" className="max-w-full max-h-[250px] object-contain" />
        </div>
      )}
      {renderInlineBrandSelector()}
      <div className="flex gap-2">
        <button onClick={handleDownload} className="flex-1 px-3 py-2 border border-border rounded-lg text-sm hover:bg-muted flex items-center justify-center gap-2">
          <Download className="w-4 h-4" /> הורד
        </button>
        <button onClick={handleSaveToProject} disabled={savingOutput}
          className="flex-1 px-3 py-2 gradient-gold text-primary-foreground rounded-lg text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50">
          {savingOutput ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {savingOutput ? 'שומר...' : 'שמור'}
        </button>
      </div>
      <div className="bg-muted/30 rounded-xl border border-border p-3 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Edit3 className="w-3.5 h-3.5" /> רוצה לשנות משהו? תאר מה לעדכן
          </p>
          <VoiceDictationButton onResult={(text) => setEditPrompt(prev => prev ? prev + ' ' + text : text)} />
        </div>
        <div className="relative">
          <textarea
            value={editPrompt}
            onChange={e => setEditPrompt(e.target.value)}
            onKeyDown={e => e.stopPropagation()}
            placeholder='למשל: "שנה את הרקע לכחול", "הוסף לוגו למעלה"'
            rows={2}
            dir="rtl"
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        {/* Reference images for refinement */}
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <ImageIcon className="w-3 h-3" /> הוסף תמונות רפרנס (אופציונלי) — {editRefPhotos.length}/{MAX_EDIT_REFS}
          </p>
          {editRefPhotos.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {editRefPhotos.map((url, i) => (
                <div key={i} className="relative group w-14 h-14 rounded-lg overflow-hidden border border-border">
                  <img src={url} alt={`ref ${i+1}`} className="w-full h-full object-cover" />
                  <button onClick={() => setEditRefPhotos(prev => prev.filter((_, idx) => idx !== i))}
                    className="absolute top-0.5 right-0.5 w-4 h-4 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {editRefPhotos.length < MAX_EDIT_REFS && (
            <div
              className={cn(
                'border-2 border-dashed border-border rounded-lg p-3 text-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors',
                uploadingEditRef && 'opacity-50 pointer-events-none'
              )}
              onClick={() => editRefInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={async e => {
                e.preventDefault(); e.stopPropagation();
                const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/')).slice(0, MAX_EDIT_REFS - editRefPhotos.length);
                if (!files.length) return;
                setUploadingEditRef(true);
                try {
                  const urls: string[] = [];
                  for (const f of files) {
                    const url = await storageService.upload(f);
                    urls.push(url);
                  }
                  setEditRefPhotos(prev => [...prev, ...urls].slice(0, MAX_EDIT_REFS));
                } catch (err: any) { toast.error(err.message || 'שגיאה בהעלאה'); }
                finally { setUploadingEditRef(false); }
              }}
            >
              {uploadingEditRef ? (
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> מעלה...
                </div>
              ) : (
                <p className="text-xs text-muted-foreground flex items-center justify-center gap-1.5">
                  <Upload className="w-3.5 h-3.5" /> גרור או לחץ להעלאת תמונות (JPG/PNG/WebP)
                </p>
              )}
            </div>
          )}
          <input
            ref={editRefInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="hidden"
            onChange={async e => {
              const files = Array.from(e.target.files || []).slice(0, MAX_EDIT_REFS - editRefPhotos.length);
              if (!files.length) return;
              setUploadingEditRef(true);
              try {
                const urls: string[] = [];
                for (const f of files) {
                  const url = await storageService.upload(f);
                  urls.push(url);
                }
                setEditRefPhotos(prev => [...prev, ...urls].slice(0, MAX_EDIT_REFS));
              } catch (err: any) { toast.error(err.message || 'שגיאה בהעלאה'); }
              finally { setUploadingEditRef(false); }
              e.target.value = '';
            }}
          />
        </div>
        <button
          onClick={async () => {
            if (!editPrompt.trim() || !result?.imageUrl) return;
            setLoading(true);
            try {
              const refs = editRefPhotos.length > 0 ? editRefPhotos : undefined;
              const arParam = imageAspectRatio !== 'auto' ? imageAspectRatio : undefined;
              const data = await imageService.edit(buildPrompt(editPrompt), result.imageUrl, refs, arParam);
              setEditHistory(prev => [...prev, { imageUrl: data.imageUrl, prompt: editPrompt, refineRefs: editRefPhotos.length > 0 ? [...editRefPhotos] : undefined }]);
              setResult({ imageUrl: data.imageUrl });
              setEditPrompt('');
              setEditRefPhotos([]);
              toast.success('התמונה עודכנה!');
            } catch (e: any) { toast.error(e.message); }
            finally { setLoading(false); }
          }}
          disabled={loading || !editPrompt.trim()}
          className="w-full gradient-gold text-primary-foreground px-4 py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
          {loading ? 'מעדכן...' : 'עדכן תמונה'}
        </button>
      </div>
      <button onClick={() => { clearSession(); setResult(null); setSelectedAction(null); setStep(0); setPrompt(''); setEditHistory([]); setEditPrompt(''); setImageRefPhotos([]); setEditRefPhotos([]); }}
        className="w-full text-sm text-muted-foreground hover:text-foreground flex items-center justify-center gap-1 py-2">
        <RefreshCw className="w-3.5 h-3.5" /> התחל מחדש
      </button>
    </div>
  );

  // ============ RENDER STEP CONTENT ============
  const renderContent = () => {
    // Step 0: Action selection
    if (step === 0) {
      return (
        <div className="space-y-2">
          {hasPendingSession && !sessionRestoreOffered && (
            <div className="bg-primary/10 border border-primary/30 rounded-xl p-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm">
                <RefreshCw className="w-4 h-4 text-primary" />
                <span className="text-foreground font-medium">יש לך עבודה שלא נשמרה</span>
              </div>
              <div className="flex gap-1.5">
                <button onClick={restoreSession} className="px-3 py-1.5 gradient-gold text-primary-foreground rounded-lg text-xs font-semibold">שחזר</button>
                <button onClick={dismissSession} className="px-3 py-1.5 border border-border rounded-lg text-xs hover:bg-muted">התעלם</button>
              </div>
            </div>
          )}
          {actionOptions.map(opt => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.id}
                onClick={() => { setSelectedAction(opt.id); setStep(1); }}
                className={cn(
                  'w-full flex items-center gap-3 p-3.5 rounded-xl border text-right transition-all hover:border-primary/50 hover:bg-primary/5',
                  'border-border bg-card'
                )}
              >
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Icon className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">{opt.label}</p>
                  <p className="text-xs text-muted-foreground">{opt.desc}</p>
                </div>
                <ArrowRight className="w-4 h-4 text-muted-foreground rotate-180 flex-shrink-0" />
              </button>
            );
          })}
        </div>
      );
    }

    const wizardStep = step - 1;

    // Show avatar/voice selector on the first step of each action
    const avatarVoiceBar = wizardStep === 0 ? renderAvatarVoiceSelector() : null;

    // ====== IMAGE ======
    if (selectedAction === 'image') {
      if (wizardStep === 0) {
        // Build all reference images including avatar
        const allRefs = [
          ...(selectedAvatar ? [selectedAvatar.image_url] : []),
          ...imageRefPhotos,
          ...(websiteContentForPrompt?.logoUrl ? [websiteContentForPrompt.logoUrl] : []),
        ];

        // If carousel mode is active, show CarouselGenerator
        if (imageMode === 'carousel' && showCarousel) {
          return (
            <CarouselGenerator
              prompt={prompt}
              buildPrompt={buildPrompt}
              activeBrand={activeBrand}
              activeBrandId={activeBrandId}
              brandColors={websiteContentForPrompt?.brandColors}
              logoUrl={websiteContentForPrompt?.logoUrl}
              referenceImages={allRefs.length > 0 ? allRefs : undefined}
              websiteContent={websiteContentForPrompt}
              onBack={() => setShowCarousel(false)}
            />
          );
        }

        return (
          <div className="space-y-4">
            {avatarVoiceBar}

            {/* Image mode toggle */}
            <div className="flex items-center gap-2 bg-muted/30 border border-border rounded-lg p-1">
              <button
                onClick={() => { setImageMode('single'); setShowCarousel(false); }}
                className={cn('flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-1.5',
                  imageMode === 'single' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                <ImageIcon className="w-3.5 h-3.5" /> תמונה אחת
              </button>
              <button
                onClick={() => setImageMode('carousel')}
                className={cn('flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-1.5',
                  imageMode === 'carousel' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                <Layers className="w-3.5 h-3.5" /> סט תמונות (קרוסלה)
              </button>
            </div>

            {renderPromptInput({ placeholder: 'תאר את התמונה... למשל: "באנר לחברת יבוא עם מוצרים על רקע מקצועי"' })}

            {/* Aspect ratio selector */}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">יחס תמונה</p>
              <div className="flex items-center gap-1.5 bg-muted/30 border border-border rounded-lg p-1">
                {([
                  { value: 'auto', label: 'אוטומטי' },
                  { value: '9:16', label: 'דיוקן (9:16)' },
                  { value: '1:1', label: 'ריבוע (1:1)' },
                  { value: '16:9', label: 'לרוחב (16:9)' },
                ] as const).map(opt => (
                  <button key={opt.value}
                    onClick={() => setImageAspectRatio(opt.value)}
                    className={cn('flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-all text-center',
                      imageAspectRatio === opt.value ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Website scan panel */}
            <WebsiteScanPanel
              onApplyContent={(data) => {
                setWebsiteContentForPrompt(data);
                // Inject chosen content into prompt
                const parts: string[] = [];
                if (data.headline) parts.push(`כותרת: ${data.headline}`);
                if (data.subheadline) parts.push(`תת-כותרת: ${data.subheadline}`);
                if (data.bullets?.length) parts.push(`נקודות: ${data.bullets.join(', ')}`);
                if (data.cta) parts.push(`CTA: ${data.cta}`);
                if (data.keywords?.length) parts.push(`מילות מפתח: ${data.keywords.join(', ')}`);
                if (data.brandColors?.length) parts.push(`צבעי מותג: ${data.brandColors.join(', ')}`);
                if (parts.length > 0) {
                  setPrompt(prev => prev ? `${prev}\n\n--- תוכן מהאתר ---\n${parts.join('\n')}` : parts.join('\n'));
                }
              }}
              onScanComplete={(result) => setWebsiteScanResult(result)}
            />

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5" /> תמונות רפרנס ({allRefs.length}/{MAX_REF_IMAGES})
              </p>
              {selectedAvatar && (
                <div className="flex items-center gap-2 text-xs text-primary bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
                  <img src={selectedAvatar.image_url} alt="" className="w-8 h-8 rounded-full object-cover border border-primary/30" />
                  <span>אווטאר "{selectedAvatar.name}" ישמש כרפרנס בתמונה</span>
                </div>
              )}
              {imageRefPhotos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {imageRefPhotos.map((url, i) => (
                    <div key={i} className="relative group w-16 h-16 rounded-lg overflow-hidden border border-border">
                      <img src={url} alt={`ref ${i+1}`} className="w-full h-full object-cover" />
                      <button onClick={() => setImageRefPhotos(prev => prev.filter((_, idx) => idx !== i))}
                        className="absolute top-0.5 right-0.5 w-5 h-5 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {allRefs.length < MAX_REF_IMAGES && (
                <FileUploadZone accept="image/*" multiple label={`העלה תמונות (${imageRefPhotos.length} נוספו)`} hint={`JPG, PNG — נשארו ${MAX_REF_IMAGES - allRefs.length} מקומות`}
                  onUploaded={url => { if (url && allRefs.length < MAX_REF_IMAGES) setImageRefPhotos(prev => [...prev, url]); }}
                  onMultipleUploaded={urls => { setImageRefPhotos(prev => [...prev, ...urls].slice(0, MAX_REF_IMAGES - (selectedAvatar ? 1 : 0))); }}
                />
              )}
            </div>

            {imageMode === 'carousel' ? (
              <button
                onClick={() => setShowCarousel(true)}
                className="w-full gradient-gold text-primary-foreground px-6 py-3 rounded-lg font-semibold text-sm flex items-center justify-center gap-2"
              >
                <Layers className="w-4 h-4" /> הגדר שקופיות קרוסלה
              </button>
            ) : (
              <button
                onClick={async () => {
                  if (!prompt.trim()) { toast.error('יש להזין תיאור'); return; }
                  setLoading(true);
                  try {
                    const refs = allRefs.length > 0 ? allRefs : undefined;
                    const avatarContext = selectedAvatar ? `\n\nIMPORTANT: Use the provided avatar/person reference image(s) — the person in the output MUST look exactly like the reference photos.` : '';
                    const arParam = imageAspectRatio !== 'auto' ? imageAspectRatio : undefined;
                    const data = await imageService.generate(buildPrompt(prompt) + avatarContext, refs, arParam);
                    setResult({ imageUrl: data.imageUrl });
                    setEditHistory([{ imageUrl: data.imageUrl, prompt }]);
                    setStep(step + 1);
                    toast.success('התמונה נוצרה!');
                  } catch (e: any) { toast.error(e.message); }
                  finally { setLoading(false); }
                }}
                disabled={loading}
                className="w-full gradient-gold text-primary-foreground px-6 py-3 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                {loading ? 'מייצר...' : 'צור תמונה'}
              </button>
            )}
          </div>
        );
      }
      if (wizardStep === 1 && result?.imageUrl) return renderImageResultWithEdit();
    }

    // ====== VIDEO AI ======
    if (selectedAction === 'video_ai') {
      return (
        <VideoWizardFlow
          avatars={availableAvatars}
          voices={availableVoices}
          activeBrand={activeBrand}
          activeBrandId={activeBrandId}
          buildPrompt={buildPrompt}
          initialCategory={initialCategory}
          brandDepartments={brandDepartments}
          onBack={() => { setSelectedAction(null); setStep(0); setVideoWizardSession(null); }}
          onClose={() => onOpenChange(false)}
          restoredSession={videoWizardSession}
          onSessionChange={(session) => {
            setVideoWizardSession(session);
            try { localStorage.setItem(VIDEO_SESSION_KEY, JSON.stringify(session)); } catch {}
          }}
        />
      );
    }

    // ====== SUBTITLES ======
    if (selectedAction === 'subtitles') {
      return (
        <SubtitleEditor
          activeBrand={activeBrand}
          onBack={() => { setSelectedAction(null); setStep(0); }}
        />
      );
    }

    // ====== IMPORT & EDIT ======
    if (selectedAction === 'import_edit') {
      const importImages = importStorageUrl ? [importStorageUrl] : [];
      
      // Step 0: URL input
      if (wizardStep === 0) return (
        <div className="space-y-4">
          {avatarVoiceBar}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                <Check className="w-3 h-3" /> נתמך: .mp4 .mov .webm .jpg .png .webp
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border">
                <X className="w-3 h-3" /> YouTube / TikTok / IG / FB: תמונה ממוזערת בלבד — יש להעלות ידנית
              </span>
            </div>
          </div>
          
          {importLoading ? (
            <div className="space-y-3 py-6 text-center">
              <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary" />
              <p className="text-sm font-medium">{importStage || 'מייבא...'}</p>
            </div>
          ) : (
            <>
              <UrlImportInput onSubmit={async (url) => {
                setImportLoading(true);
                setImportStage('מזהה סוג תוכן...');
                try {
                  setImportStage('בודק קישור...');
                  const importResult = await importService.importUrl(url);
                  
                  // Platform link — show message, don't proceed
                  if (importResult.isPlatform) {
                    if (importResult.isYoutube) {
                      setImportUrl(url);
                      setImportType('image');
                      setImportStorageUrl(importResult.publicUrl);
                      toast.warning(importResult.platformMessage || 'קישורי YouTube אינם ניתנים להורדה. יש להעלות את הסרטון ידנית.', { duration: 6000 });
                      setStep(step + 1);
                    } else {
                      toast.error(importResult.platformMessage || 'קישורי פלטפורמות אינם ניתנים להורדה. יש להעלות את הקובץ ידנית.', { duration: 6000 });
                    }
                    return;
                  }
                  
                  setImportUrl(url);
                  setImportType(importResult.type);
                  setImportStorageUrl(importResult.publicUrl);
                  setImportStage('');
                  
                  // Auto-save as source output in project
                  try {
                    const brandId = activeBrandId || inlineBrandId;
                    const brandObj = activeBrand || brands.find(b => b.id === brandId);
                    let project;
                    if (brandId && brandObj) {
                      project = await projectService.findOrCreateByBrand(brandId, brandObj.name, effectiveCategory || undefined);
                    } else {
                      // No brand selected — create a generic import project
                      project = await projectService.create({
                        name: `ייבוא — ${new Date().toLocaleDateString('he-IL')}`,
                        video_type: 'ייבוא ועריכה',
                        status: 'טיוטה',
                      });
                    }
                    await projectService.addOutput(project.id, {
                      name: `מקור מיובא — ${importResult.type === 'video' ? 'סרטון' : 'תמונה'}`,
                      description: `מקור: ${url}`,
                      video_url: importResult.type === 'video' ? importResult.publicUrl : null,
                      thumbnail_url: importResult.type === 'image' ? importResult.publicUrl : null,
                      provider: 'import',
                    });
                    toast.success('נשמר כפרויקט!');
                  } catch (saveErr) {
                    console.warn('Auto-save to project failed:', saveErr);
                  }
                  
                  toast.success(importResult.type === 'video' ? 'סרטון יובא בהצלחה!' : 'תמונה יובאה בהצלחה!');
                  setStep(step + 1);
                } catch (e: any) {
                  toast.error(e.message || 'שגיאה בייבוא');
                } finally {
                  setImportLoading(false);
                  setImportStage('');
                }
              }} placeholder="הדבק קישור ישיר לתמונה או סרטון (JPG, PNG, WebP, MP4, MOV, WebM)..." />
              
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" /> או העלה קבצים <span className="h-px flex-1 bg-border" />
              </div>
              
              <FileUploadZone accept="image/*,video/*" multiple label="העלה תמונות או סרטון" hint={`JPG, PNG, MP4 — עד ${MAX_REF_IMAGES} קבצים`}
                onUploaded={url => {
                  if (url) {
                    const isVideo = url.match(/\.(mp4|mov|webm)/i);
                    setImportUrl(url);
                    setImportStorageUrl(url);
                    setImportType(isVideo ? 'video' : 'image');
                    setStep(step + 1);
                  }
                }}
                onMultipleUploaded={urls => {
                  if (urls.length > 0) {
                    const isVideo = urls[0].match(/\.(mp4|mov|webm)/i);
                    setImportUrl(urls[0]);
                    setImportStorageUrl(urls[0]);
                    setImportType(isVideo ? 'video' : 'image');
                    if (urls.length > 1) setImageRefPhotos(prev => [...prev, ...urls.slice(1)].slice(0, MAX_REF_IMAGES));
                    setStep(step + 1);
                  }
                }}
              />
            </>
          )}
          
          {selectedAvatar && (
            <div className="flex items-center gap-2 text-xs text-primary bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
              <img src={selectedAvatar.image_url} alt="" className="w-8 h-8 rounded-full object-cover border border-primary/30" />
              <span>אווטאר "{selectedAvatar.name}" יצורף אוטומטית כרפרנס</span>
            </div>
          )}
        </div>
      );

      // ====== IMAGE EDIT FLOW ======
      if (importType === 'image') {
        if (wizardStep === 1) {
          const allEditRefs = [
            ...importImages,
            ...(selectedAvatar ? [selectedAvatar.image_url] : []),
            ...imageRefPhotos,
          ];

          return (
            <div className="space-y-4">
              {/* Preview the imported image */}
              {importStorageUrl && (
                <div className="rounded-lg overflow-hidden border border-border bg-muted/30 flex items-center justify-center">
                  <img src={importStorageUrl} alt="מקור" className="max-w-full max-h-[200px] object-contain" />
                </div>
              )}
              
              <div className="flex flex-wrap gap-2">
                {allEditRefs.slice(1).map((url, i) => (
                  <div key={i} className="relative w-14 h-14 rounded-lg overflow-hidden border border-border">
                    <img src={url} alt={`ref ${i+1}`} className="w-full h-full object-cover" />
                  </div>
                ))}
                {allEditRefs.length < MAX_REF_IMAGES && (
                  <FileUploadZone accept="image/*" multiple label="+" hint=""
                    onUploaded={url => { if (url) setImageRefPhotos(prev => [...prev, url]); }}
                    onMultipleUploaded={urls => setImageRefPhotos(prev => [...prev, ...urls].slice(0, MAX_REF_IMAGES))}
                  />
                )}
              </div>
              
              {renderPromptInput({ placeholder: 'תאר מה תרצה לשנות... למשל: "שנה את הצבעים למותג שלי", "הוסף כיתוב בעברית"' })}
              
              <button
                onClick={async () => {
                  if (!prompt.trim()) { toast.error('יש להזין תיאור'); return; }
                  setLoading(true);
                  try {
                    const avatarContext = selectedAvatar ? `\n\nIMPORTANT: The avatar/person reference is included — preserve their exact likeness in the output.` : '';
                    const extraRefs = allEditRefs.length > 1 ? `\n\nAdditional reference images are provided (${allEditRefs.length} total). Use ALL of them as context.` : '';
                    const data = await imageService.edit(buildPrompt(prompt) + avatarContext + extraRefs, importStorageUrl);
                    setResult({ imageUrl: data.imageUrl });
                    setEditHistory([{ imageUrl: data.imageUrl, prompt }]);
                    setStep(step + 1);
                    toast.success('העריכה הושלמה!');
                  } catch (e: any) { toast.error(e.message); }
                  finally { setLoading(false); }
                }}
                disabled={loading}
                className="w-full gradient-gold text-primary-foreground px-6 py-3 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                {loading ? 'עורך...' : 'ערוך'}
              </button>
            </div>
          );
        }
        if (wizardStep === 2 && result?.imageUrl) return renderImageResultWithEdit();
      }

      // ====== VIDEO EDIT FLOW ======
      if (importType === 'video') {
        // Step 1: Preview video + choose what to do
        if (wizardStep === 1) {
          return (
            <div className="space-y-4">
              {/* Video preview */}
              {importStorageUrl && (
                <div className="rounded-lg overflow-hidden border border-border bg-muted/30">
                  <video src={importStorageUrl} controls className="w-full max-h-[220px]" />
                </div>
              )}
              
              <p className="text-xs text-muted-foreground">הסרטון נשמר באחסון. בחר מה תרצה לעשות:</p>
              
              {/* PiP Avatar toggle */}
              {selectedAvatar && (
                <label className="flex items-center gap-3 bg-muted/30 border border-border rounded-lg p-3 cursor-pointer hover:border-primary/30 transition-colors">
                  <input
                    type="checkbox"
                    checked={importPipAvatar}
                    onChange={e => setImportPipAvatar(e.target.checked)}
                    className="accent-primary w-4 h-4"
                  />
                  <div className="flex items-center gap-2 flex-1">
                    <img src={selectedAvatar.image_url} alt="" className="w-8 h-8 rounded-full object-cover border border-primary/30" />
                    <div>
                      <p className="text-sm font-medium flex items-center gap-1.5">
                        <PictureInPicture2 className="w-3.5 h-3.5" /> הוסף אווטאר PiP
                      </p>
                      <p className="text-xs text-muted-foreground">"{selectedAvatar.name}" יוצג כשכבה בפינת הסרטון</p>
                    </div>
                  </div>
                </label>
              )}
              
              {/* Action cards */}
              <div className="grid grid-cols-1 gap-2">
                <button
                  onClick={() => { setImportVideoEditMode('subtitles'); setStep(step + 1); }}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 text-right transition-all"
                >
                  <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Subtitles className="w-4.5 h-4.5 text-primary" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold">כתוביות + לוגו + מוזיקה + ייצוא</p>
                    <p className="text-xs text-muted-foreground">תמלול, עיצוב כתוביות, הוספת לוגו ומוזיקה, וייצוא MP4 סופי</p>
                  </div>
                </button>
                
                <button
                  onClick={() => {
                    setImportVideoEditMode('edit');
                    setStep(step + 1);
                  }}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 text-right transition-all"
                >
                  <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Wand2 className="w-4.5 h-4.5 text-primary" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold">עריכה חכמה (AI)</p>
                    <p className="text-xs text-muted-foreground">בקש שינויים בטקסט — חיתוך, שינוי סגנון, שיפור</p>
                  </div>
                </button>
              </div>
            </div>
          );
        }

        // Step 2: Video editing
        if (wizardStep === 2) {
          if (importVideoEditMode === 'subtitles') {
            return (
              <SubtitleEditor
                activeBrand={activeBrand}
                initialVideoUrl={importStorageUrl}
                pipAvatarUrl={importPipAvatar && selectedAvatar ? selectedAvatar.image_url : undefined}
                onBack={() => setStep(step - 1)}
                onComplete={(videoUrl) => {
                  setResult({ videoUrl });
                  setStep(step + 1);
                }}
              />
            );
          }
          
          if (importVideoEditMode === 'edit') {
            return (
              <div className="space-y-4">
                {/* Show video */}
                {importStorageUrl && (
                  <div className="rounded-lg overflow-hidden border border-border bg-muted/30">
                    <video src={importStorageUrl} controls className="w-full max-h-[180px]" />
                  </div>
                )}
                
                {renderPromptInput({ placeholder: 'תאר מה תרצה לשנות בסרטון...\n\nלמשל: "חתוך ל-30 שניות הראשונות", "הוסף כתוביות ולוגו", "שנה את הגודל ל-9:16"' })}
                
                <div className="bg-muted/30 border border-border rounded-lg p-3 text-xs text-muted-foreground space-y-1">
                  <p className="font-medium text-foreground">💡 מה אפשר לעשות:</p>
                  <p>• חיתוך וקיצור הסרטון</p>
                  <p>• הוספת כתוביות בעברית</p>
                  <p>• הוספת לוגו ומוזיקת רקע</p>
                  <p>• שינוי יחס גובה-רוחב (9:16, 16:9)</p>
                  {selectedAvatar && importPipAvatar && <p>• אווטאר PiP יתווסף אוטומטית</p>}
                </div>
                
                <button
                  onClick={async () => {
                    if (!prompt.trim()) { toast.error('יש להזין הנחיות'); return; }
                    setLoading(true);
                    try {
                      // For now, redirect to subtitle editor with the prompt as context
                      // The compose-video pipeline handles the actual processing
                      toast.info('מעביר לעורך הוידאו...');
                      setImportVideoEditMode('subtitles');
                    } catch (e: any) {
                      toast.error(e.message || 'שגיאה');
                    } finally {
                      setLoading(false);
                    }
                  }}
                  disabled={loading}
                  className="w-full gradient-gold text-primary-foreground px-6 py-3 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                  {loading ? 'מעבד...' : 'המשך לעריכה'}
                </button>
              </div>
            );
          }
        }

        // Step 3: Result
        if (wizardStep === 3 && result?.videoUrl) return renderResultView();
      }
    }

    // ====== HIGHLIGHT (Long → Short Viral) ======
    if (selectedAction === 'highlight') {
      return (
        <HighlightWizardFlow
          activeBrand={activeBrand}
          activeBrandId={activeBrandId}
          onComplete={() => {
            clearSession();
            setSelectedAction(null);
            setStep(0);
          }}
          onBack={() => { setSelectedAction(null); setStep(0); }}
        />
      );
    }

    return null;
  };

  const stepInfo = getStepInfo();
  const totalSteps = getTotalSteps();
  const currentStepNum = step + 1;
  const preventSubtitleAccidentalClose = selectedAction === 'subtitles';

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg max-h-[90vh] md:max-h-[85vh] overflow-y-auto w-[95vw] md:w-full"
        dir="rtl"
        onInteractOutside={(event) => {
          if (preventSubtitleAccidentalClose) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (preventSubtitleAccidentalClose) event.preventDefault();
        }}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            {step > 0 && (
              <button onClick={handleBack} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
                <ChevronLeft className="w-5 h-5 rotate-180" />
              </button>
            )}
            <div className="flex-1">
              <DialogTitle className="font-rubik text-lg flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                {stepInfo.title}
              </DialogTitle>
              <p className="text-xs text-muted-foreground mt-0.5">{stepInfo.desc}</p>
            </div>
          </div>

          {selectedAction && selectedAction !== 'video_ai' && selectedAction !== 'subtitles' && selectedAction !== 'highlight' && (
            <div className="flex items-center gap-1.5 mt-3">
              {Array.from({ length: totalSteps }).map((_, i) => (
                <div
                  key={i}
                  className={cn(
                    'h-1.5 rounded-full flex-1 transition-all',
                    i < currentStepNum ? 'bg-primary' : 'bg-muted'
                  )}
                />
              ))}
            </div>
          )}

          {activeBrand && (
            <div className="mt-2 text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-1.5 flex items-center gap-1.5">
              <span className="text-primary">●</span> {activeBrand.name}
              {activeBrand.industry && <span className="text-muted-foreground/70">• {activeBrand.industry}</span>}
            </div>
          )}
        </DialogHeader>

        <div className="mt-2">
          {renderContent()}
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
