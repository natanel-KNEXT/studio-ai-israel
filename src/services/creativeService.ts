import { supabase } from "@/integrations/supabase/client";

const withTimeout = async <T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

// ====== File Upload Service ======
export const storageService = {
  /**
   * Upload a file via the storage-manager edge function (uses service role, no RLS issues).
   */
  upload: async (file: File): Promise<string> => {
    // Convert file to base64
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    const { data, error } = await supabase.functions.invoke("storage-manager", {
      body: {
        action: "upload",
        fileName: file.name,
        fileType: file.type,
        fileBase64: base64,
      },
    });
    if (error) throw new Error(error.message || 'שגיאה בהעלאת קובץ');
    if (data?.error) throw new Error(data.error);
    return data.publicUrl;
  },
};

// ====== Image Generation Service ======
export const imageService = {
  generate: async (prompt: string, referenceImages?: string[], aspectRatio?: string): Promise<{ imageUrl: string; text: string }> => {
    const { data, error } = await supabase.functions.invoke("generate-image", {
      body: { prompt, action: "generate", referenceImages, aspectRatio },
    });
    if (error) throw new Error(error.message || "שגיאה ביצירת תמונה");
    if (data?.error) throw new Error(data.error);
    return data;
  },

  edit: async (prompt: string, imageUrl: string, referenceImages?: string[], aspectRatio?: string): Promise<{ imageUrl: string; text: string }> => {
    const { data, error } = await supabase.functions.invoke("generate-image", {
      body: { prompt, action: "edit", imageUrl, referenceImages, aspectRatio },
    });
    if (error) throw new Error(error.message || "שגיאה בעריכת תמונה");
    if (data?.error) throw new Error(data.error);
    return data;
  },
};

// ====== Voice Generation Service (ElevenLabs) ======
export const voiceService = {
  generate: async (text: string, voiceId?: string): Promise<string> => {
    const { data, error } = await supabase.functions.invoke("text-to-speech", {
      body: { text, voiceId },
    });
    if (error) throw new Error(error.message || "שגיאה ביצירת קול");
    if (data instanceof Blob) {
      return URL.createObjectURL(data);
    }
    if (data?.error) throw new Error(data.error);
    throw new Error("תגובה לא צפויה מהשרת");
  },

  /**
   * Generate TTS and upload to cloud storage, returning a public URL
   * suitable for use with Shotstack / HeyGen compositing.
   */
  generateAndUpload: async (text: string, voiceId?: string): Promise<string> => {
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    const safeText = normalizedText.length > 4500 ? `${normalizedText.slice(0, 4500)}...` : normalizedText;
    if (!safeText) throw new Error('אין טקסט לקריינות');

    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/text-to-speech`;
    const controller = new AbortController();
    const abortId = setTimeout(() => controller.abort(), 120000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({ text: safeText, voiceId }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let apiError = `שגיאה ביצירת קריינות: ${response.status}`;
        try {
          const data = await response.json();
          if (data?.error) apiError = data.error;
        } catch {
          // ignore json parsing issues
        }
        throw new Error(apiError);
      }

      const blob = await response.blob();
      const file = new File([blob], `narration-${Date.now()}.mp3`, { type: 'audio/mpeg' });
      return await withTimeout(
        storageService.upload(file),
        120000,
        'העלאת הקריינות לקחה יותר מדי זמן. נסה שוב.'
      );
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new Error('יצירת הקריינות לקחה יותר מדי זמן (timeout). ממשיך בלי קריינות מותאמת.');
      }
      throw error;
    } finally {
      clearTimeout(abortId);
    }
  },
};

// ====== Avatar Generation Service (AI) ======
export const avatarGenService = {
  generate: async (
    imageUrls: string[],
    style?: string,
    options?: { baseAvatarUrl?: string; strictIdentity?: boolean; expression?: string; skipAnalysis?: boolean; cachedFaceDescription?: string }
  ): Promise<{ imageUrl: string | null; text: string; faceDescription?: string; identityDrift?: boolean }> => {
    const { data, error } = await supabase.functions.invoke("generate-avatar", {
      body: { imageUrls, style, ...options },
    });
    if (error) throw new Error(error.message || "שגיאה ביצירת אווטאר");
    if (data?.error) throw new Error(data.error);
    return data;
  },
};

// ====== Avatar DB Service (CRUD) ======
export const avatarDbService = {
  list: async () => {
    const { data, error } = await supabase.functions.invoke("avatar-manager", {
      body: { action: "list" },
    });
    if (error) throw new Error(error.message || "שגיאה בטעינת אווטארים");
    if (data?.error) throw new Error(data.error);
    return data.avatars || [];
  },

  save: async (name: string, imageUrl: string, style: string, sourcePhotos: string[]) => {
    const { data, error } = await supabase.functions.invoke("avatar-manager", {
      body: { action: "save", name, image_url: imageUrl, style, source_photos: sourcePhotos },
    });
    if (error) throw new Error(error.message || "שגיאה בשמירת אווטאר");
    if (data?.error) throw new Error(data.error);
    return data.avatar;
  },

  remove: async (id: string) => {
    const { data, error } = await supabase.functions.invoke("avatar-manager", {
      body: { action: "delete", id },
    });
    if (error) throw new Error(error.message || "שגיאה במחיקת אווטאר");
    if (data?.error) throw new Error(data.error);
  },
};

// ====== Voice Clone + TTS Service ======
export const voiceCloneService = {
  cloneAndSpeak: async (params: {
    scriptText: string;
    audioUrl?: string;
    providerVoiceId?: string;
    language?: 'he' | 'en' | 'ar';
    voiceSettings?: Record<string, unknown>;
    modelId?: string;
    omitLanguageCode?: boolean;
    trainingAudioDurationSec?: number;
    trainingAudioSizeBytes?: number;
    trainingAudioFileName?: string;
    trainingAudioContentType?: string;
    trainingAudioCodec?: string;
  }): Promise<{
    audioUrl: string;
    voiceId: string;
    clonedFresh?: boolean;
    modelId?: string;
    language?: string | null;
    voiceSettings?: Record<string, unknown>;
    warning?: string;
    trainingAudioUrlUsed?: string | null;
    trainingAudioDurationSec?: number | null;
    trainingAudioSizeBytes?: number | null;
    trainingAudioContentType?: string | null;
    trainingAudioCodec?: string | null;
  }> => {
    return withTimeout(
      (async () => {
        const body: Record<string, unknown> = {
          scriptText: params.scriptText,
          language: params.language,
          voiceSettings: params.voiceSettings,
          modelId: params.modelId,
          omitLanguageCode: params.omitLanguageCode,
          trainingAudioDurationSec: params.trainingAudioDurationSec,
          trainingAudioSizeBytes: params.trainingAudioSizeBytes,
          trainingAudioFileName: params.trainingAudioFileName,
          trainingAudioContentType: params.trainingAudioContentType,
          trainingAudioCodec: params.trainingAudioCodec,
        };

        if (params.providerVoiceId) {
          body.providerVoiceId = params.providerVoiceId;
        } else if (params.audioUrl) {
          body.audioUrl = params.audioUrl;
        } else {
          throw new Error('יש לספק מזהה קול ספק או קובץ אימון');
        }

        const { data, error } = await supabase.functions.invoke("clone-voice-tts", {
          body,
        });

        if (error) throw new Error(error.message || "שגיאה בשכפול קול");
        if (data?.error) throw new Error(data.error);
        return data;
      })(),
      120000,
      'שכפול הקול לקח יותר מדי זמן (timeout)'
    );
  },
};

// ====== Video Compositing Service (Shotstack) ======
export const composeService = {
  render: async (params: {
    videoUrl: string;
    videoUrls?: string[];
    scenes: any[];
    logoUrl?: string;
    logoPlacement?: { xPct: number; yPct: number; scalePct: number; opacity: number };
    brandColors?: string[];
    audioUrl?: string;
    subtitleStyle?: Record<string, any>;
    stickers?: any[];
    subtitleSegments?: { start: number; end: number; text: string }[];
    totalDuration?: number;
    orientation?: string;
    sourceWidth?: number;
    sourceHeight?: number;
    captionPosition?: string;
  }): Promise<{
    renderId: string | null;
    status: string;
    outputUrl: string | null;
    thumbnailUrl: string | null;
    subtitleCount: number;
    logoPlacementSummary: any;
    shotstackEnv?: 'production' | 'stage';
  }> => {
    const { data, error } = await supabase.functions.invoke("compose-video", {
      body: { action: "render", ...params },
    });
    if (error) throw new Error(error.message || "שגיאה בהרכבת סרטון");

    return {
      renderId: data?.renderId ?? null,
      status: data?.status ?? "failed:unknown",
      outputUrl: data?.outputUrl ?? null,
      thumbnailUrl: data?.thumbnailUrl ?? null,
      subtitleCount: Number(data?.subtitleCount) || 0,
      logoPlacementSummary: data?.logoPlacementSummary ?? null,
      shotstackEnv: data?.shotstackEnv,
    };
  },

  checkStatus: async (
    renderId: string,
    shotstackEnv?: 'production' | 'stage'
  ): Promise<{ status: string; url: string | null; outputUrl: string | null; thumbnailUrl: string | null; progress: number }> => {
    const { data, error } = await supabase.functions.invoke("compose-video", {
      body: { action: "check_status", renderId, shotstackEnv },
    });
    if (error) throw new Error(error.message || "שגיאה בבדיקת סטטוס");

    const normalizedStatus = data?.status ?? "failed:unknown";
    const outputUrl = data?.outputUrl ?? null;

    return {
      status: normalizedStatus,
      url: outputUrl,
      outputUrl,
      thumbnailUrl: data?.thumbnailUrl ?? null,
      progress:
        normalizedStatus === "done" ? 100 :
        normalizedStatus === "rendering" ? 50 :
        normalizedStatus === "fetching" ? 20 : 10,
    };
  },
};

// ====== HeyGen Avatar Service ======
export const heygenService = {
  createVideo: async (
    script: string,
    avatarId?: string,
    voiceId?: string,
    audioUrl?: string,
    aspectRatio?: string
  ): Promise<{ videoId: string; status: string }> => {
    const { data, error } = await supabase.functions.invoke("heygen-video", {
      body: { action: "create_video", script, avatarId, voiceId, audioUrl, aspectRatio },
    });
    if (error) throw new Error(error.message || "שגיאה ביצירת סרטון אווטאר");
    if (data?.error) throw new Error(data.error);
    return data;
  },

  checkStatus: async (videoId: string): Promise<{ status: string; videoUrl: string | null; thumbnailUrl: string | null; progress: number }> => {
    const { data, error } = await supabase.functions.invoke("heygen-video", {
      body: { action: "check_status", videoId },
    });
    if (error) throw new Error(error.message || "שגיאה בבדיקת סטטוס");
    if (data?.error) throw new Error(data.error);
    return data;
  },

  listAvatars: async () => {
    const { data, error } = await supabase.functions.invoke("heygen-video", {
      body: { action: "list_avatars" },
    });
    if (error) throw new Error(error.message || "שגיאה בטעינת אווטארים");
    if (data?.error) throw new Error(data.error);
    return data.avatars || [];
  },

  listVoices: async () => {
    const { data, error } = await supabase.functions.invoke("heygen-video", {
      body: { action: "list_voices" },
    });
    if (error) throw new Error(error.message || "שגיאה בטעינת קולות");
    if (data?.error) throw new Error(data.error);
    return data.voices || [];
  },
};

// ====== D-ID Avatar Service (legacy, kept for backward compat) ======
export const didService = heygenService as any;

// ====== Transcription / Subtitles Service ======
export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}

export interface CaptionCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface TranscriptionDebug {
  provider: string;
  status: number;
  sourceAudioUrl: string;
  videoDuration: number;
  totalCueCount: number;
  firstCues: CaptionCue[];
  providerBody?: string;
}

export const subtitleService = {
  transcribe: async ({
    sourceAudioUrl,
    language = 'עברית',
    videoDuration,
  }: {
    sourceAudioUrl: string;
    language?: string;
    videoDuration: number;
  }): Promise<{ captions: CaptionCue[]; segments: SubtitleSegment[]; debug: TranscriptionDebug }> => {
    const { data, error } = await supabase.functions.invoke("transcribe-audio", {
      body: { sourceAudioUrl, language, videoDuration },
    });

    if (error) {
      throw new Error(error.message || 'שגיאה בתמלול');
    }

    if (data?.error) {
      const provider = data?.provider || 'STT';
      const status = data?.status ?? 'לא ידוע';
      const providerBody = typeof data?.providerBody === 'string' ? data.providerBody : '';
      throw new Error(
        `התמלול נכשל (${provider}, סטטוס ${status}). ${data.error}${providerBody ? `\nתגובת ספק: ${providerBody}` : ''}`
      );
    }

    const rawCaptions: any[] = data?.captions;
    if (!Array.isArray(rawCaptions) || rawCaptions.length === 0) {
      throw new Error('התמלול החזיר מבנה לא תקין: חסר captions[] עם זמנים אמיתיים.');
    }

    const issues: string[] = [];
    const captions: CaptionCue[] = [];
    let prevEnd = 0;

    for (let i = 0; i < rawCaptions.length; i += 1) {
      const cue = rawCaptions[i];
      const startSec = Number(cue?.startSec);
      const endSec = Number(cue?.endSec);
      const text = typeof cue?.text === 'string' ? cue.text.trim() : '';

      if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
        issues.push(`#${i + 1}: זמן לא מספרי`);
        continue;
      }

      if (startSec < 0) {
        issues.push(`#${i + 1}: startSec קטן מ-0 (${startSec})`);
      }

      if (endSec <= startSec) {
        issues.push(`#${i + 1}: endSec חייב להיות גדול מ-startSec (${startSec} -> ${endSec})`);
      }

      if (i > 0 && startSec < prevEnd) {
        issues.push(`#${i + 1}: זמנים לא מונוטוניים (${startSec} < ${prevEnd})`);
      }

      if (endSec > videoDuration + 0.05) {
        issues.push(`#${i + 1}: endSec חורג מאורך הסרטון (${endSec} > ${videoDuration})`);
      }

      if (!text) {
        issues.push(`#${i + 1}: טקסט ריק`);
      }

      prevEnd = endSec;
      captions.push({
        startSec: Number(startSec.toFixed(3)),
        endSec: Number(endSec.toFixed(3)),
        text,
      });
    }

    if (issues.length > 0) {
      const providerBody = typeof data?.providerBody === 'string' ? data.providerBody.slice(0, 600) : '';
      throw new Error(
        `התמלול החזיר כתוביות לא תקינות ולכן הופסק. ${issues.slice(0, 5).join(' | ')}${providerBody ? `\nתגובת ספק: ${providerBody}` : ''}`
      );
    }

    const segments: SubtitleSegment[] = captions.map((cue) => ({
      start: cue.startSec,
      end: cue.endSec,
      text: cue.text,
    }));

    return {
      captions,
      segments,
      debug: {
        provider: data?.provider || 'elevenlabs/scribe_v2',
        status: Number(data?.status ?? 200),
        sourceAudioUrl: data?.sourceAudioUrl || sourceAudioUrl,
        videoDuration,
        totalCueCount: captions.length,
        firstCues: captions.slice(0, 3),
        providerBody: typeof data?.providerBody === 'string' ? data.providerBody : undefined,
      },
    };
  },

  toSRT: (segments: SubtitleSegment[]): string => {
    return segments.map((seg, i) => {
      const formatTime = (s: number) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        const ms = Math.round((s % 1) * 1000);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
      };
      return `${i + 1}\n${formatTime(seg.start)} --> ${formatTime(seg.end)}\n${seg.text}\n`;
    }).join('\n');
  },
};

// ====== RunwayML Video Service ======
export const runwayService = {
  imageToVideo: async (promptImage: string, promptText: string, model?: string, duration?: number, ratio?: string) => {
    const { data, error } = await supabase.functions.invoke("runway-video", {
      body: { action: "image_to_video", promptImage, promptText, model, duration, ratio },
    });
    if (error) throw new Error(error.message || "שגיאה ביצירת וידאו");
    if (data?.error) throw new Error(data.error);
    return data as { taskId: string };
  },

  textToVideo: async (promptText: string, model?: string, duration?: number, ratio?: string) => {
    const { data, error } = await supabase.functions.invoke("runway-video", {
      body: { action: "text_to_video", promptText, model, duration, ratio },
    });
    if (error) throw new Error(error.message || "שגיאה ביצירת וידאו");
    if (data?.error) throw new Error(data.error);
    return data as { taskId: string };
  },

  checkStatus: async (taskId: string) => {
    const { data, error } = await supabase.functions.invoke("runway-video", {
      body: { action: "check_status", taskId },
    });
    if (error) throw new Error(error.message || "שגיאה בבדיקת סטטוס");
    if (data?.error) throw new Error(data.error);
    return data as { status: string; progress: number; resultUrl: string | null; failureReason: string | null };
  },
};

// ====== Prompt Enhancement Service ======
export const promptEnhanceService = {
  enhance: async (text: string, type: "enhance" | "script" = "enhance") => {
    const { data, error } = await supabase.functions.invoke("enhance-prompt", {
      body: { text, type },
    });
    if (error) throw new Error(error.message || "שגיאה בשיפור הפרומפט");
    if (data?.error) throw new Error(data.error);
    return data;
  },
};

// ====== Brand Management (Supabase DB via REST) ======
export interface Brand {
  id: string;
  name: string;
  logo?: string;
  colors: string[];
  tone: string;
  targetAudience: string;
  industry: string;
  departments?: string[];
}

const BRANDS_KEY = "creative_studio_brands"; // legacy localStorage key

const REST_BASE = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1`;
const REST_HEADERS = {
  'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
};

function rowToBrand(row: any): Brand {
  return {
    id: row.id,
    name: row.name,
    logo: row.logo || undefined,
    colors: row.colors || [],
    tone: row.tone || '',
    targetAudience: row.target_audience || '',
    industry: row.industry || '',
    departments: row.departments || [],
  };
}

function brandToRow(b: Brand) {
  return {
    id: b.id,
    name: b.name,
    logo: b.logo || null,
    colors: b.colors || [],
    tone: b.tone || '',
    target_audience: b.targetAudience || '',
    industry: b.industry || '',
    departments: b.departments || [],
  };
}

export const brandService = {
  getAllAsync: async (): Promise<Brand[]> => {
    try {
      const res = await fetch(`${REST_BASE}/brands?select=*&order=created_at.asc`, { headers: REST_HEADERS });
      if (!res.ok) throw new Error(await res.text());
      return ((await res.json()) || []).map(rowToBrand);
    } catch (e) {
      console.error('Failed to fetch brands from DB', e);
      return brandService.getAll();
    }
  },

  getAll: (): Brand[] => {
    try {
      const raw = localStorage.getItem(BRANDS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  },

  save: (brands: Brand[]) => {
    localStorage.setItem(BRANDS_KEY, JSON.stringify(brands));
  },

  add: async (brand: Brand): Promise<Brand[]> => {
    try {
      await fetch(`${REST_BASE}/brands`, {
        method: 'POST',
        headers: { ...REST_HEADERS, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(brandToRow(brand)),
      });
    } catch (e) { console.error('Failed to save brand to DB', e); }
    const brands = brandService.getAll();
    brands.push(brand);
    brandService.save(brands);
    return brands;
  },

  update: async (id: string, updates: Partial<Brand>): Promise<Brand[]> => {
    try {
      const dbUpdates: any = {};
      if (updates.name !== undefined) dbUpdates.name = updates.name;
      if (updates.logo !== undefined) dbUpdates.logo = updates.logo;
      if (updates.colors !== undefined) dbUpdates.colors = updates.colors;
      if (updates.tone !== undefined) dbUpdates.tone = updates.tone;
      if (updates.targetAudience !== undefined) dbUpdates.target_audience = updates.targetAudience;
      if (updates.industry !== undefined) dbUpdates.industry = updates.industry;
      if (updates.departments !== undefined) dbUpdates.departments = updates.departments;
      await fetch(`${REST_BASE}/brands?id=eq.${id}`, {
        method: 'PATCH',
        headers: REST_HEADERS,
        body: JSON.stringify(dbUpdates),
      });
    } catch (e) { console.error('Failed to update brand in DB', e); }
    const brands = brandService.getAll().map(b => b.id === id ? { ...b, ...updates } : b);
    brandService.save(brands);
    return brands;
  },

  remove: async (id: string): Promise<Brand[]> => {
    try {
      await fetch(`${REST_BASE}/brands?id=eq.${id}`, { method: 'DELETE', headers: REST_HEADERS });
    } catch (e) { console.error('Failed to delete brand from DB', e); }
    const brands = brandService.getAll().filter(b => b.id !== id);
    brandService.save(brands);
    return brands;
  },

  migrateLocalToDb: async (): Promise<number> => {
    const local = brandService.getAll();
    if (local.length === 0) return 0;
    let count = 0;
    for (const brand of local) {
      try {
        const res = await fetch(`${REST_BASE}/brands`, {
          method: 'POST',
          headers: { ...REST_HEADERS, 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify(brandToRow(brand)),
        });
        if (res.ok) count++;
      } catch {}
    }
    return count;
  },

  exportAll: async (): Promise<{ brands: Brand[], scripts: any[] }> => {
    const brands = await brandService.getAllAsync();
    const localBrands = brandService.getAll();
    const allBrands = [...brands];
    for (const lb of localBrands) {
      if (!allBrands.find(b => b.id === lb.id)) allBrands.push(lb);
    }
    let scripts: any[] = [];
    try { scripts = JSON.parse(localStorage.getItem('studio-scripts') || '[]'); } catch {}
    // Also fetch from DB
    try {
      const res = await fetch(`${REST_BASE}/scripts?select=*&order=created_at.desc`, { headers: REST_HEADERS });
      if (res.ok) {
        const dbScripts = await res.json();
        for (const ds of dbScripts) {
          if (!scripts.find((s: any) => s.id === ds.id)) {
            scripts.push({ id: ds.id, name: ds.name, content: ds.content, createdAt: ds.created_at });
          }
        }
      }
    } catch {}
    return { brands: allBrands, scripts };
  },
};

// ====== Website Scraper Service (Firecrawl) ======
export interface WebsiteScrapeResult {
  screenshot?: string; // URL or base64
  screenshotIsUrl?: boolean;
  markdown?: string;
  branding?: {
    logo?: string;
    colors?: Record<string, string>;
    fonts?: { family: string }[];
    colorScheme?: string;
  };
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
    ogImage?: string;
  };
  links?: string[];
}

export const websiteScraperService = {
  scrape: async (url: string): Promise<WebsiteScrapeResult> => {
    const { data, error } = await supabase.functions.invoke('firecrawl-scrape', {
      body: {
        url,
        options: {
          formats: ['markdown', 'screenshot', 'branding', 'links'],
          onlyMainContent: false, // Get full page for better screenshot
          waitFor: 5000, // Wait longer for full render
        },
      },
    });
    if (error) throw new Error(error.message || 'שגיאה בסריקת האתר');
    if (data?.success === false) throw new Error(data.error || 'שגיאה בסריקת האתר');

    // Firecrawl nests inside data.data
    const result = data?.data || data;
    
    // Screenshot can be a URL or base64 string
    let screenshot = result?.screenshot;
    let screenshotIsUrl = false;
    if (screenshot && (screenshot.startsWith('http://') || screenshot.startsWith('https://'))) {
      screenshotIsUrl = true;
    }

    // Extract OG image from metadata as fallback
    const ogImage = result?.metadata?.ogImage || result?.metadata?.['og:image'];

    return {
      screenshot,
      screenshotIsUrl,
      markdown: result?.markdown,
      branding: result?.branding,
      metadata: {
        ...result?.metadata,
        ogImage,
      },
      links: result?.links,
    };
  },

  /** Get a usable image URL from scrape result — screenshot or OG image */
  getScreenshotUrl: (result: WebsiteScrapeResult): string | null => {
    if (result.screenshot) {
      if (result.screenshotIsUrl) return result.screenshot;
      // Base64 — return as data URL
      if (result.screenshot.startsWith('data:')) return result.screenshot;
      return `data:image/png;base64,${result.screenshot}`;
    }
    // Fallback to OG image
    if (result.metadata?.ogImage) return result.metadata.ogImage;
    // Fallback to branding logo
    if (result.branding?.logo) return result.branding.logo;
    return null;
  },
};

// ====== Krea AI Service (Images + Videos + Upscale) ======
export const kreaService = {
  /** Generate image using Krea AI (Flux, Nano Banana Pro, Seedream 4, ChatGPT Image) */
  generate: async (prompt: string, options?: {
    model?: 'flux' | 'nano-banana-pro' | 'seedream-4' | 'chatgpt-image';
    width?: number;
    height?: number;
    imageUrls?: string[];
  }): Promise<{ imageUrl: string; jobId: string }> => {
    const { data, error } = await supabase.functions.invoke('krea-image', {
      body: {
        action: 'generate',
        prompt,
        model: options?.model || 'flux',
        width: options?.width || 1024,
        height: options?.height || 1024,
        imageUrls: options?.imageUrls,
      },
    });
    if (error) throw new Error(error.message || 'שגיאה ביצירת תמונה ב-Krea');
    if (data?.error) throw new Error(data.error);
    return { imageUrl: data.imageUrl, jobId: data.jobId };
  },

  /** Generate video using Krea AI (Veo 3, Kling 2.5, Hailuo, Wan 2.5) */
  generateVideo: async (prompt: string, options?: {
    model?: 'veo-3' | 'veo-3.1' | 'kling-2.5' | 'hailuo-2.3' | 'wan-2.5';
    width?: number;
    height?: number;
    duration?: number;
    imageUrl?: string;
  }): Promise<{ videoUrl: string | null; jobId: string }> => {
    const { data, error } = await supabase.functions.invoke('krea-image', {
      body: {
        action: 'generate_video',
        prompt,
        model: options?.model || 'veo-3',
        width: options?.width || 1280,
        height: options?.height || 720,
        duration: options?.duration || 8,
        imageUrl: options?.imageUrl,
      },
    });
    if (error) throw new Error(error.message || 'שגיאה ביצירת וידאו ב-Krea');
    if (data?.error) throw new Error(data.error);
    return { videoUrl: data.videoUrl, jobId: data.jobId };
  },

  /** Upscale image using Krea AI (Topaz-powered, up to 22K) */
  upscale: async (imageUrl: string, options?: {
    mode?: 'standard' | 'bloom' | 'generative';
    scaleFactor?: number;
  }): Promise<{ imageUrl: string; jobId: string }> => {
    const { data, error } = await supabase.functions.invoke('krea-image', {
      body: {
        action: 'upscale',
        imageUrl,
        mode: options?.mode || 'standard',
        scaleFactor: options?.scaleFactor || 2,
      },
    });
    if (error) throw new Error(error.message || 'שגיאה בשיפור רזולוציה');
    if (data?.error) throw new Error(data.error);
    return { imageUrl: data.imageUrl, jobId: data.jobId };
  },

  /** Check job status */
  checkStatus: async (jobId: string) => {
    const { data, error } = await supabase.functions.invoke('krea-image', {
      body: { action: 'check_status', jobId },
    });
    if (error) throw new Error(error.message || 'שגיאה בבדיקת סטטוס');
    if (data?.success === false) throw new Error(data.error || 'כשל בבדיקת סטטוס Krea');
    return data;
  },
};

// ====== ElevenLabs Sound Effects Service ======
export const soundEffectService = {
  /** Generate AI sound effect from text description */
  generate: async (text: string, durationSeconds?: number): Promise<string> => {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/elevenlabs-music`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
      },
      body: JSON.stringify({ action: 'sound_effect', text, duration_seconds: durationSeconds }),
    });
    if (!response.ok) throw new Error('שגיאה ביצירת אפקט סאונד');
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  },

  /** Isolate vocals from background noise */
  isolate: async (audioBase64: string): Promise<string> => {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/elevenlabs-music`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
      },
      body: JSON.stringify({ action: 'isolate', audioBase64 }),
    });
    if (!response.ok) throw new Error('שגיאה בבידוד קול');
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  },

  /** List all ElevenLabs voices */
  listVoices: async () => {
    const { data, error } = await supabase.functions.invoke('elevenlabs-music', {
      body: { action: 'list_voices' },
    });
    if (error) throw new Error(error.message || 'שגיאה בטעינת קולות');
    return data?.voices || [];
  },
};

// ====== HeyGen Extended Service ======
export const heygenExtendedService = {
  /** Create video from own photo (Talking Photo) */
  createPhotoAvatarVideo: async (
    photoUrl: string,
    script: string,
    voiceId?: string,
    audioUrl?: string,
    aspectRatio?: string
  ): Promise<{ videoId: string; status: string }> => {
    const { data, error } = await supabase.functions.invoke('heygen-video', {
      body: { action: 'create_photo_avatar_video', photoUrl, script, voiceId, audioUrl, aspectRatio },
    });
    if (error) throw new Error(error.message || 'שגיאה ביצירת תמונה מדברת');
    if (data?.error) throw new Error(data.error);
    return data;
  },

  /** List HeyGen templates */
  listTemplates: async () => {
    const { data, error } = await supabase.functions.invoke('heygen-video', {
      body: { action: 'list_templates' },
    });
    if (error) throw new Error(error.message || 'שגיאה בטעינת תבניות');
    return data?.templates || [];
  },

  /** Create video from template */
  createFromTemplate: async (templateId: string, variables?: Record<string, any>) => {
    const { data, error } = await supabase.functions.invoke('heygen-video', {
      body: { action: 'create_from_template', templateId, variables },
    });
    if (error) throw new Error(error.message || 'שגיאה ביצירה מתבנית');
    if (data?.error) throw new Error(data.error);
    return data;
  },

  /** Get remaining quota */
  getQuota: async () => {
    const { data, error } = await supabase.functions.invoke('heygen-video', {
      body: { action: 'get_quota' },
    });
    if (error) throw new Error(error.message || 'שגיאה בבדיקת מכסה');
    return data?.quota || {};
  },
};

// ====== URL Import Service ======
export interface ImportResult {
  type: 'image' | 'video';
  sourceUrl: string;
  publicUrl: string;
  storagePath?: string;
  isYoutube?: boolean;
  youtubeId?: string;
  isPlatform?: boolean;
  platformMessage?: string;
  metadata?: Record<string, any>;
}

export const importService = {
  /** Import a URL (image/video) — downloads to storage and returns public URL + metadata */
  importUrl: async (url: string): Promise<ImportResult> => {
    const { data, error } = await supabase.functions.invoke('import-url', {
      body: { url },
    });
    if (error) throw new Error(error.message || 'שגיאה בייבוא');
    if (data?.error) throw new Error(data.error);
    return data as ImportResult;
  },
};
