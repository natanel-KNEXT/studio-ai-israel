import { useState, useEffect, useRef, useCallback } from 'react';
import { Check, Loader2, ExternalLink, RefreshCw, AlertTriangle, CheckCircle2, Sparkles, Mic, UserCircle, Video, ImageIcon, Subtitles, Bell, Zap, Wand2, ShieldCheck, ShieldAlert, ShieldX, CircleDot, Route, DollarSign, Lock, Unlock, Info, Coins } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface ProviderStatus {
  service: string;
  readiness: string;
  authValid: boolean;
  creditsAvailable: boolean | null;
  modelsAccessible: boolean | null;
  liveGenerationPassed: boolean | null;
  environment: string;
  used: number;
  limit: number;
  unit: string;
  plan: string;
  canGenerate: boolean;
  dashboardUrl: string;
  statusLabel: string;
  lastFailureReason?: string;
  error?: string;
}

interface BalanceResult {
  ok: boolean;
  remaining: number | null;
  total: number | null;
  used: number | null;
  unit: string;
  resetAt?: string | null;
  reason?: string;
}

// ═══════════════════════════════════════════════════════════
//  PRODUCTION ROUTING — explicit safe stack definition
// ═══════════════════════════════════════════════════════════

type ProviderRole = 'ברירת מחדל' | 'גיבוי' | 'חסום ידנית' | 'לא פעיל';

interface ProviderMeta {
  id: string;
  balanceKey: string; // key in provider-balances response
  name: string;
  desc: string;
  icon: any;
  free: boolean;
  plan: string;
  hasCredits: boolean;
  role: ProviderRole;
  category: string;
  safeForGeneration: boolean;
  blockedManually: boolean;
  requiresApproval: boolean;
  noAutoGeneration: boolean;
  billingType: string;
  monthlyCost: string;
  extraCreditsNeeded: boolean;
  costConfirmed: boolean;
}

const serviceConfig: ProviderMeta[] = [
  { id: 'gemini', balanceKey: 'lovable_ai', name: 'Gemini AI', desc: 'תמונות + טקסט + תסריטים + שיפור פרומפטים', icon: Sparkles, free: true, plan: 'חינם (מובנה)',
    hasCredits: false, role: 'ברירת מחדל', category: 'תמונות / תסריטים / פרומפטים', safeForGeneration: true, blockedManually: false, requiresApproval: false, noAutoGeneration: true,
    billingType: 'Lovable AI — ללא עלות נוספת', monthlyCost: '$0', extraCreditsNeeded: false, costConfirmed: true },
  { id: 'elevenlabs', balanceKey: 'elevenlabs', name: 'ElevenLabs', desc: 'דיבוב, שכפול קול, מוזיקה, SFX', icon: Mic, free: false, plan: 'חינם (מוגבל)',
    hasCredits: true, role: 'ברירת מחדל', category: 'קול / דיבוב בעברית', safeForGeneration: true, blockedManually: false, requiresApproval: false, noAutoGeneration: true,
    billingType: 'מנוי חודשי + תוים', monthlyCost: '$5–$22', extraCreditsNeeded: false, costConfirmed: true },
  { id: 'heygen', balanceKey: 'heygen', name: 'HeyGen', desc: 'אווטאר מדבר, Photo Avatar, תבניות', icon: UserCircle, free: false, plan: 'חינם (Trial)',
    hasCredits: true, role: 'ברירת מחדל', category: 'אווטאר מדבר / וידאו', safeForGeneration: true, blockedManually: false, requiresApproval: false, noAutoGeneration: true,
    billingType: 'קרדיטים — 591 נותרו', monthlyCost: 'Trial חינם', extraCreditsNeeded: false, costConfirmed: true },
  { id: 'runway', balanceKey: 'runway', name: 'RunwayML', desc: 'וידאו AI קולנועי (Image/Text → Video)', icon: Video, free: false, plan: 'Fallback בלבד',
    hasCredits: true, role: 'גיבוי', category: 'וידאו AI', safeForGeneration: true, blockedManually: false, requiresApproval: true, noAutoGeneration: true,
    billingType: 'קרדיטים — Fallback', monthlyCost: '$12/month', extraCreditsNeeded: false, costConfirmed: true },
  { id: 'krea', balanceKey: 'krea', name: 'Krea AI', desc: '40+ מודלים: Flux, Veo 3, Kling 2.5, Upscale', icon: Wand2, free: false, plan: 'API מחובר',
    hasCredits: true, role: 'גיבוי', category: 'תמונות / וידאו (Fallback)', safeForGeneration: true, blockedManually: false, requiresApproval: false, noAutoGeneration: true,
    billingType: 'תשלום לפי שימוש', monthlyCost: 'משתנה', extraCreditsNeeded: false, costConfirmed: false },
  { id: 'shotstack', balanceKey: 'shotstack', name: 'Shotstack', desc: 'עריכת וידאו, רינדור רב-שכבתי, כתוביות', icon: Video, free: false, plan: 'Production',
    hasCredits: true, role: 'ברירת מחדל', category: 'הרכבה / רינדור סופי', safeForGeneration: true, blockedManually: false, requiresApproval: false, noAutoGeneration: true,
    billingType: 'תשלום לפי רינדור', monthlyCost: 'משתנה', extraCreditsNeeded: false, costConfirmed: false },
  { id: 'cloudinary', balanceKey: 'cloudinary', name: 'Cloudinary', desc: 'ניהול מדיה, עיבוד תמונות ווידאו', icon: ImageIcon, free: false, plan: 'חינם (מוגבל)',
    hasCredits: true, role: 'לא פעיל', category: 'אחסון מדיה', safeForGeneration: false, blockedManually: false, requiresApproval: false, noAutoGeneration: true,
    billingType: 'חינם עד 25GB', monthlyCost: '$0', extraCreditsNeeded: false, costConfirmed: true },
  { id: 'perplexity', balanceKey: 'perplexity', name: 'Perplexity AI', desc: 'ניתוח טרנדים ויראליים בזמן אמת', icon: Zap, free: false, plan: 'API מחובר',
    hasCredits: false, role: 'ברירת מחדל', category: 'ניתוח טרנדים', safeForGeneration: true, blockedManually: false, requiresApproval: false, noAutoGeneration: true,
    billingType: 'תשלום לפי שימוש', monthlyCost: 'משתנה', extraCreditsNeeded: false, costConfirmed: false },
  { id: 'whisper', balanceKey: '', name: 'Whisper AI', desc: 'כתוביות אוטומטיות בעברית', icon: Subtitles, free: true, plan: 'חינם (מובנה)',
    hasCredits: false, role: 'ברירת מחדל', category: 'כתוביות / תמלול', safeForGeneration: true, blockedManually: false, requiresApproval: false, noAutoGeneration: true,
    billingType: 'Lovable AI — ללא עלות נוספת', monthlyCost: '$0', extraCreditsNeeded: false, costConfirmed: true },
  { id: 'storage', balanceKey: '', name: 'אחסון מדיה', desc: 'העלאה ושמירת קבצים', icon: ImageIcon, free: true, plan: 'חינם (מובנה)',
    hasCredits: false, role: 'ברירת מחדל', category: 'אחסון', safeForGeneration: true, blockedManually: false, requiresApproval: false, noAutoGeneration: true,
    billingType: 'כלול ב-Lovable Cloud', monthlyCost: '$0', extraCreditsNeeded: false, costConfirmed: true },
];

const readinessColors: Record<string, { bg: string; text: string; icon: typeof CheckCircle2 }> = {
  generation_verified: { bg: 'bg-success/15', text: 'text-success', icon: CheckCircle2 },
  credits_ok: { bg: 'bg-success/10', text: 'text-success', icon: ShieldCheck },
  authenticated: { bg: 'bg-warning/15', text: 'text-warning', icon: ShieldAlert },
  connected: { bg: 'bg-info/15', text: 'text-info', icon: CircleDot },
  blocked_credits: { bg: 'bg-destructive/15', text: 'text-destructive', icon: ShieldX },
  blocked_env: { bg: 'bg-warning/15', text: 'text-warning', icon: ShieldAlert },
  auth_failed: { bg: 'bg-destructive/15', text: 'text-destructive', icon: ShieldX },
  error: { bg: 'bg-destructive/15', text: 'text-destructive', icon: AlertTriangle },
  not_configured: { bg: 'bg-muted', text: 'text-muted-foreground', icon: CircleDot },
};

const roleBadge: Record<ProviderRole, { bg: string; text: string }> = {
  'ברירת מחדל': { bg: 'bg-primary/15', text: 'text-primary' },
  'גיבוי': { bg: 'bg-info/15', text: 'text-info' },
  'חסום ידנית': { bg: 'bg-destructive/15', text: 'text-destructive' },
  'לא פעיל': { bg: 'bg-muted', text: 'text-muted-foreground' },
};

const BALANCE_REFRESH_INTERVAL = 5 * 60_000; // 5 minutes

export function ConnectionsTab() {
  const [credits, setCredits] = useState<Record<string, ProviderStatus>>({});
  const [balances, setBalances] = useState<Record<string, BalanceResult>>({});
  const [loading, setLoading] = useState(false);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [balanceUpdatedAt, setBalanceUpdatedAt] = useState<Date | null>(null);
  const prevCreditsRef = useRef<Record<string, ProviderStatus>>({});
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  const loadCredits = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('check-credits');
      if (error) throw error;
      const map: Record<string, ProviderStatus> = {};
      for (const c of (data?.credits || [])) {
        map[c.service] = c;
      }

      const prev = prevCreditsRef.current;
      for (const [svc, cur] of Object.entries(map)) {
        const old = prev[svc];
        if (!old) continue;
        if (old.canGenerate && !cur.canGenerate) {
          const name = serviceConfig.find(s => s.id === svc)?.name || svc;
          toast.error(`⚠️ ${name} — ${cur.statusLabel || 'חסום'}`, { duration: 10000 });
        }
      }

      prevCreditsRef.current = map;
      setCredits(map);
      setLastUpdated(new Date());
    } catch (err: any) {
      console.error('Error loading credits:', err);
      if (!silent) toast.error('שגיאה בטעינת נתוני ספקים');
    } finally {
      setLoading(false);
    }
  };

  const loadBalances = useCallback(async (silent = false) => {
    if (!silent) setBalanceLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('provider-balances');
      if (error) throw error;
      setBalances(data?.providers || {});
      setBalanceUpdatedAt(new Date(data?.updatedAt || Date.now()));
    } catch (err: any) {
      console.error('Error loading balances:', err);
      if (!silent) toast.error('שגיאה בטעינת יתרות ספקים');
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCredits();
    loadBalances();
    intervalRef.current = setInterval(() => {
      loadCredits(true);
      loadBalances(true);
    }, BALANCE_REFRESH_INTERVAL);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  const getUsagePercent = (c: ProviderStatus) => {
    if (c.limit <= 0) return 0;
    return Math.min(100, Math.round((c.used / c.limit) * 100));
  };

  const getUsageColor = (percent: number, canGenerate: boolean) => {
    if (!canGenerate) return 'bg-destructive';
    if (percent > 80) return 'bg-warning';
    return 'bg-success';
  };

  const formatTimeAgo = (date: Date) => {
    const diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 10) return 'עכשיו';
    if (diff < 60) return `לפני ${diff} שניות`;
    return `לפני ${Math.floor(diff / 60)} דקות`;
  };

  const blockedCount = Object.values(credits).filter(c => c.readiness === 'blocked_credits' || c.readiness === 'auth_failed').length;
  const warningCount = Object.values(credits).filter(c => c.readiness === 'authenticated' || c.readiness === 'blocked_env').length;
  const verifiedCount = Object.values(credits).filter(c => c.readiness === 'generation_verified').length;

  return (
    <div className="space-y-6">
      {/* ═══ PRODUCTION ROUTING PANEL ═══ */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Route className="w-5 h-5 text-primary" />
          <h2 className="font-rubik font-semibold">מסלול ייצור פעיל</h2>
          <span className="text-xs px-2 py-0.5 rounded-full bg-success/15 text-success font-medium">בטוח לשימוש</span>
        </div>
        <p className="text-xs text-muted-foreground">המסלול הבטוח הנוכחי ליצירת תוכן — ללא שינויים אוטומטיים, ללא קריאות רקע.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-muted/30 rounded-lg p-3 space-y-2">
            <p className="text-xs font-semibold text-primary flex items-center gap-1.5"><Unlock className="w-3.5 h-3.5" /> ספקי ברירת מחדל</p>
            <ul className="text-xs space-y-1.5 text-foreground">
              <li className="flex items-center gap-2"><UserCircle className="w-3.5 h-3.5 text-primary" /><span><strong>HeyGen</strong> — אווטאר מדבר בעברית</span></li>
              <li className="flex items-center gap-2"><Mic className="w-3.5 h-3.5 text-primary" /><span><strong>ElevenLabs</strong> — קריינות ודיבוב בעברית</span></li>
              <li className="flex items-center gap-2"><Video className="w-3.5 h-3.5 text-primary" /><span><strong>Shotstack</strong> — הרכבה ורינדור סופי</span></li>
              <li className="flex items-center gap-2"><Sparkles className="w-3.5 h-3.5 text-primary" /><span><strong>Gemini</strong> — תסריטים, פרומפטים, תמונות</span></li>
            </ul>
          </div>

          <div className="space-y-3">
            <div className="bg-info/5 border border-info/20 rounded-lg p-3 space-y-1.5">
              <p className="text-xs font-semibold text-info flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> שרשרת גיבוי (Fallback)</p>
              <p className="text-xs text-foreground">HeyGen → Krea → Runway → תמונת AI סטטית</p>
              <p className="text-[10px] text-muted-foreground">Runway משמש כגיבוי אחרון לפני תמונה סטטית, כשכל הספקים הראשיים לא זמינים</p>
            </div>
            <div className="bg-info/5 border border-info/20 rounded-lg p-3 space-y-1.5">
              <p className="text-xs font-semibold text-info flex items-center gap-1.5"><Lock className="w-3.5 h-3.5" /> ספק גיבוי</p>
              <p className="text-xs text-foreground"><strong>RunwayML</strong> — Fallback בלבד (לא ספק ברירת מחדל)</p>
              <p className="text-[10px] text-muted-foreground">Runway משמש כגיבוי בלבד כאשר HeyGen ו-Krea לא זמינים</p>
            </div>
          </div>
        </div>

        <div className="bg-success/5 border border-success/20 rounded-lg p-3">
          <p className="text-xs font-semibold text-success flex items-center gap-1.5 mb-1.5"><ShieldCheck className="w-3.5 h-3.5" /> הבטחות בטיחות פעילות</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 text-[11px] text-foreground">
            <span>✅ לא מבצע יצירה אוטומטית</span>
            <span>✅ לא מבצע יצירה בטעינת דף</span>
            <span>✅ לא מבצע יצירה בריענון</span>
            <span>✅ לא מבצע בדיקות יקרות</span>
            <span>✅ הגנה מפני כפילויות</span>
            <span>✅ Runway גיבוי בלבד</span>
          </div>
        </div>
      </div>

      {/* ═══ PIPELINE STAGES — detailed flow ═══ */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Route className="w-5 h-5 text-primary" />
          <h2 className="font-rubik font-semibold">שלבי הצינור — Flow מלא</h2>
          <span className="text-xs px-2 py-0.5 rounded-full bg-primary/15 text-primary font-medium">סדר ביצוע</span>
        </div>
        <p className="text-xs text-muted-foreground">פירוט מסודר של כל שלב בייצור הסרטון — הקלט, הכלי שמתחבר, והפלט שעובר לשלב הבא.</p>

        <ol className="space-y-3">
          {[
            {
              n: 1, title: 'איסוף קלט וניתוח קריאייטיבי',
              tool: 'firecrawl-scrape + scrape-website-content + Gemini 2.5 Pro',
              icon: Sparkles,
              desc: 'נקודת ההתחלה. המשתמש מזין נושא, פרומפט חופשי, או מצמיד URL/קובץ.',
              input: 'נושא טקסטואלי / URL אתר / קובץ PDF/DOCX / תמונה ייחוס',
              params: 'industry, target_audience, tone, brand_id (אופציונלי), aspect_ratio (9:16/1:1/16:9/Auto)',
              flow: 'אם הוזן URL: firecrawl-scrape (timeout 20 שנ׳) → fallback scrape-website-content (Gemini Flash, timeout 15 שנ׳). התוכן הנקי מועבר ל-Gemini 2.5 Pro לניתוח קהל יעד, טון וזווית.',
              errors: 'אם שני הסקרייפרים נכשלים — שגיאה ברורה בעברית עם המלצה להזין טקסט ידני. אין fallback שקט.',
              out: 'בריף קריאייטיבי מובנה (JSON: topic, audience, tone, hooks, references)',
            },
            {
              n: 2, title: 'אופטימיזציית פרומפט (Enhance)',
              tool: 'enhance-prompt (Gemini Flash → Pro → GPT-4o-mini)',
              icon: Wand2,
              desc: 'הפרומפט הגולמי עובר ניתוח והשלמת פרטים חסרים. ניתן להפעיל גם ידנית דרך "שפר פרומפט".',
              input: 'פרומפט גולמי + סוג וידאו + קהל יעד',
              params: 'enhance_level (basic/professional/cinematic), language (he), keep_user_intent (true)',
              flow: 'שרשרת מודלים אוטומטית: Gemini Flash מנסה ראשון. כשל → Gemini Pro. כשל → GPT-4o-mini. עצירה אחרי הצלחה ראשונה.',
              errors: 'fallback אוטומטי בין מודלים. אם כולם נכשלים — הפרומפט המקורי משמש כברירת מחדל (לא חוסם המשך).',
              out: 'פרומפט מועשר עם פרטים ויזואליים, סגנון, וטון. נשמר ב-projects.enhanced_prompt.',
            },
            {
              n: 3, title: 'יצירת תסריט בעברית',
              tool: 'generate-script (Gemini 2.5 Flash → Pro → GPT-4o-mini)',
              icon: Wand2,
              desc: 'יצירת תסריט עברי אותנטי מחולק לסצנות עם הוראות בימוי לכל סצנה.',
              input: 'פרומפט מועשר משלב 2 + קהל יעד + משך מבוקש (30 שנ׳ – 10 דק׳)',
              params: 'scene_count (3–6), language (he-IL), duration_seconds, voice_style, aspect_ratio',
              flow: 'שרשרת מודלים: Flash → Pro → GPT-4o-mini. כל סצנה: title, spokenText, visualDescription, duration. אכיפת משך מצטבר.',
              errors: 'אם כל המודלים נכשלים — שגיאה מובנית עם providerError. אין fallback לתסריט גנרי.',
              out: 'JSON: scenes[] עם 3–6 סצנות + נראטיב מסודר',
            },
            {
              n: 4, title: 'הרחבה והעמקה (Director Pass)',
              tool: 'generate-script (Ultra Director mode)',
              icon: Sparkles,
              desc: 'מעבר שני שמרחיב כל סצנה ל-8–10 שורות בימוי מפורטות.',
              input: 'תסריט בסיסי משלב 3 + הוראות סגנון',
              params: 'mode=director_pass, detail_level=ultra, identity_lock=true',
              flow: 'Gemini 2.5 Pro Ultra Director מוסיף לכל סצנה: זווית מצלמה, תאורה, אווירה, מיקרו-פעולות של האווטאר, תזמון. Identity Lock מבטיח שזהות חזותית של אווטאר נשמרת בין סצנות.',
              errors: 'אם נכשל — ניתן לדלג ולהמשיך עם התסריט הבסיסי משלב 3 (לא חוסם).',
              out: 'תסריט מועשר מוכן ל-Prompt-to-Video',
            },
            {
              n: 5, title: 'בדיקת קרדיטים ואישור עלות',
              tool: 'check-credits + provider-balances + CostApprovalDialog',
              icon: DollarSign,
              desc: 'שער בקרה לפני כל הוצאה. בלי אישור — שום ספק בתשלום לא נקרא.',
              input: 'רשימת ספקים נדרשים לפי השלבים הבאים',
              params: 'auto_refresh=5min, timeout_per_provider=25s (check-credits), 15s (provider-balances)',
              flow: 'check-credits מחזיר readiness מפורט (auth_valid + credits_available + models_accessible + live_generation_passed) לכל ספק. provider-balances מחזיר יתרות בזמן אמת. CostApprovalDialog מציג עלות מוערכת ודורש לחיצה.',
              errors: 'ספק חסום → blocked_credits / auth_failed → השלב הבא דולג עליו אוטומטית בשרשרת ה-fallback. timeout → unknown (לא חוסם).',
              out: 'אישור מפורש + מפת readiness לכל ספק',
            },
            {
              n: 6, title: 'קריינות (Text-to-Speech)',
              tool: 'text-to-speech / clone-voice-tts (ElevenLabs eleven_v3 he)',
              icon: Mic,
              desc: 'יצירת קריינות עברית עם הקול הנבחר מספריית הקולות.',
              input: 'spokenText של כל סצנה + voice_id משלב הבחירה',
              params: 'model=eleven_v3, language_code=he, chunk_duration=10–20s, voice_settings (stability, similarity_boost)',
              flow: 'אם הקול הוא משוכפל (provider_voice_id קיים) → clone-voice-tts. אחרת text-to-speech. צ׳אנקים של 10–20 שניות לסנכרון מיטבי. A/B verification של זהות קולית.',
              errors: 'כשל ElevenLabs → fallback לקול ברירת מחדל עברי. אם quota חרוג → שגיאה ברורה עם קישור לדשבורד.',
              out: 'audio_url (MP3 ב-Supabase Storage) + duration_seconds + נשמר ב-voice_generations',
            },
            {
              n: 7, title: 'יצירת/דיבוב אווטאר מדבר',
              tool: 'heygen-video v2 (action=create_video) — קולט audio_url משלב 6',
              icon: UserCircle,
              desc: 'HeyGen מקבל את ה-audio_url מ-ElevenLabs (לא טקסט!) — לסנכרון שפתיים מדויק בעברית.',
              input: 'avatar_id + audio_url משלב 6 + aspect_ratio + avatar_style',
              params: 'dimension (9:16=720x1280 / 1:1=720x720 / 16:9=1280x720), avatar_style (normal/cartoon), polling_interval=10s',
              flow: 'יצירת job → polling עד completion. Timeout: 15 דקות (HEYGEN_GENERATION_TIMEOUT_MS=900000). Pass 1 משמש מקור לכל ההבעות (Identity Lock).',
              errors: 'אם avatar_style=cartoon → דלג על HeyGen, עבור ישר ל-Krea. אם credits חסומים → fallback ל-Krea. אם נכשל לאחר 15 דק׳ → fallback chain.',
              out: 'קליפ אווטאר מדבר (MP4) עם סנכרון שפתיים מלא',
            },
            {
              n: 8, title: 'יצירת תמונות / B-roll',
              tool: 'generate-image (Gemini 3 Pro Image Preview) + krea-image (Flux/Seedream 4/Kling)',
              icon: ImageIcon,
              desc: 'תמונות תומכות לסצנות. יחס המסך נשמר במדויק לפי בחירת המשתמש.',
              input: 'prompt לכל סצנה + aspect_ratio + reference_images (עד 5)',
              params: 'aspectRatio (Auto/9:16/1:1/16:9 — נשלח מפורשות למודל), action (generate/edit), model (flux/seedream/kling), width/height עד 22K (Krea)',
              flow: 'Gemini 3 Pro Image לעברית ברורה על תמונה (RTL מלא). Krea ל-Hi-Res (Flux 1MP, Seedream 4 עד 22K). שיפור פרומפט אוטומטי לפי aspect ratio.',
              errors: 'Gemini quota → fallback ל-Krea. Krea quota → תמונת placeholder עם הודעה ברורה.',
              out: 'נכסים ויזואליים לכל סצנה (URLs ב-Supabase Storage)',
            },
            {
              n: 9, title: 'גיבוי וידאו (שרשרת Fallback)',
              tool: 'heygen-video → krea-image (image-to-video) → runway-video → תמונה סטטית',
              icon: ShieldCheck,
              desc: 'אם HeyGen נכשל או לא רלוונטי — שרשרת גיבויים אוטומטית. Runway רק כגיבוי ידני.',
              input: 'avatar_url או scene_image + scene_prompt + duration',
              params: 'HEYGEN_TIMEOUT=15min, KREA_FALLBACK_TIMEOUT=6min, RUNWAY_START_TIMEOUT=30s, RUNWAY_PROMPT_MAX_CHARS=נורמליזציה',
              flow: 'Provider 1: HeyGen (אם heygenFallbackEnabled=true). Provider 2: Krea video (Kling 2.5 / Veo 3). Provider 3: Runway (gen4.5, רק אם credits מאומתים — דורש אישור ידני). Last resort: תמונה סטטית עם קריינות בלולאה.',
              errors: 'כל ספק שנכשל → debugLogs מפורט עם providerError. אם Runway credits = 0 → דילוג אוטומטי. שגיאת ענן credits של Krea → איפוס forceKreaOnlyMode.',
              out: 'קליפ וידאו (MP4) או תמונה סטטית עם קריינות',
            },
            {
              n: 10, title: 'כתוביות (Subtitles)',
              tool: 'transcribe-audio (ElevenLabs Scribe v2) + opentype.js (SVG Path)',
              icon: Subtitles,
              desc: 'תמלול האודיו ורינדור כתוביות עבריות מדויקות לוויזואל.',
              input: 'audio_url משלב 6 + video_url + content_rect dimensions',
              params: 'model=scribe_v2 (LOCKED), language=he, granularity=word, font=Heebo/Rubik, safe_zone=bottom 60%',
              flow: 'Scribe v2 מתמלל עם תזמון ברמת מילה. opentype.js יוצר SVG Path בעברית מלאה (תמיכת RTL מלאה, ללא קיצוצים, ללא ellipsis). סנכרון דרך requestVideoFrameCallback.',
              errors: 'Scribe v2 תמיד נעול — אין מעבר ל-v1. אם נכשל → אפשרות עריכה ידנית של כתוביות.',
              out: 'subtitles.json + SVG layer מסונכרן',
            },
            {
              n: 11, title: 'מוזיקת רקע (BGM) — אופציונלי',
              tool: 'elevenlabs-music (action=music / sound_effect)',
              icon: Mic,
              desc: 'יצירת או בחירת מוזיקת רקע עם ducking אוטומטי.',
              input: 'mood prompt או SFX text + duration_seconds (default 30)',
              params: 'duration_seconds, mood (calm/upbeat/dramatic), ducking_db=-12dB during narration',
              flow: 'אם המשתמש בחר BGM → elevenlabs-music יוצר טראק. ducking אוטומטי: עוצמת BGM יורדת ב-12dB כאשר יש קריינות (זוהה דרך Scribe v2 timestamps).',
              errors: 'אם נכשל → ממשיך ללא BGM (לא חוסם). הודעה נראית למשתמש.',
              out: 'רצועת BGM (MP3) עם metadata ל-ducking',
            },
            {
              n: 12, title: 'הרכבה ורינדור סופי',
              tool: 'compose-video (Shotstack multi-layer)',
              icon: Video,
              desc: 'הרכבה רב-שכבתית של כל הנכסים לוידאו סופי.',
              input: 'avatar_clip + b_roll[] + subtitles_svg + logos[] (עד 2) + bgm + content_rect',
              params: 'output_format=mp4, resolution לפי aspect_ratio, fps=30, audio_normalization=true',
              flow: 'Shotstack מקבל timeline JSON עם שכבות (avatar, b-roll, subtitles, logos, BGM). מיפוי קואורדינטות ל-Content Rect (יחסי % לפיקסלים בפועל, מתעלם מ-letterbox). polling עד render completion.',
              errors: 'render failure → debugLogs מלא + אפשרות לחזור עם resume לפי runId. timeout → הודעה ברורה עם זמן בפועל.',
              out: 'וידאו סופי (MP4) + thumbnail (PNG) + render_id',
            },
            {
              n: 13, title: 'שמירה, גרסאות ו-Output Editor',
              tool: 'storage-manager + Supabase Storage + project_outputs + project_versions',
              icon: CheckCircle2,
              desc: 'שמירה לא-הרסנית עם היסטוריית גרסאות מלאה.',
              input: 'video_url + thumbnail + metadata (provider, duration, scenes, prompt)',
              params: 'parent_output_id (לגרסה חדשה), bucket=media (public), signed_url_ttl=runtime',
              flow: 'storage-manager מעלה לקובץ ל-bucket media. רשומה נכתבת ל-project_outputs (status, provider, video_url, script, prompt). אם זו גרסה — parent_output_id מקשר לקודמת. project_versions מתעדכן עם changes.',
              errors: 'כשל העלאה → retry אוטומטי 3 פעמים. כשל DB → השמירה מקומית עד התאוששות. cascade delete של פרויקט מוחק את כל הגרסאות.',
              out: 'project_output שמור + היסטוריית גרסאות + Output Editor (Preview/Edit/Versions)',
            },
          ].map(s => {
            const Icon = s.icon;
            return (
              <li key={s.n} className="flex gap-3 bg-muted/20 border border-border/40 rounded-lg p-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/15 text-primary font-bold flex items-center justify-center text-sm">
                  {s.n}
                </div>
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Icon className="w-4 h-4 text-primary flex-shrink-0" />
                    <h3 className="text-sm font-semibold text-foreground">{s.title}</h3>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">{s.tool}</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{s.desc}</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 text-[11px] pt-1">
                    <p className="text-foreground"><strong className="text-primary">קלט:</strong> <span className="text-muted-foreground">{s.input}</span></p>
                    <p className="text-foreground"><strong className="text-primary">פרמטרים:</strong> <span className="text-muted-foreground font-mono text-[10px]">{s.params}</span></p>
                    <p className="text-foreground md:col-span-2"><strong className="text-primary">זרימה:</strong> <span className="text-muted-foreground">{s.flow}</span></p>
                    <p className="text-foreground md:col-span-2"><strong className="text-warning">טיפול בשגיאות:</strong> <span className="text-muted-foreground">{s.errors}</span></p>
                  </div>
                  <p className="text-[11px] text-success flex items-start gap-1.5 pt-1 border-t border-border/30">
                    <CircleDot className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    <span><strong>פלט:</strong> {s.out}</span>
                  </p>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="bg-info/5 border border-info/20 rounded-lg p-3 space-y-1.5">
          <p className="text-xs font-semibold text-info flex items-center gap-1.5"><Info className="w-3.5 h-3.5" /> עקרונות חוצי-שלבים</p>
          <ul className="text-[11px] text-foreground space-y-1 list-disc list-inside">
            <li><strong>Fail-fast:</strong> כל שגיאה מוצגת בעברית מובנית (functionName, status, providerError) — ללא כשלים שקטים.</li>
            <li><strong>Strict Truth:</strong> שלב נחשב מוצלח רק אחרי הוכחה E2E (ניתן לבדיקה דרך /proof-test).</li>
            <li><strong>Cost Gate:</strong> כל פעולה בתשלום עוברת CostApprovalDialog — אין עקיפות.</li>
            <li><strong>Observability:</strong> activeRunId + debugLogs לכל ריצה, ניתן לחזור עם resume לפי runId.</li>
            <li><strong>Identity Lock:</strong> זהות חזותית וקולית של אווטאר נשמרת בין סצנות (Pass 1 מקור).</li>
          </ul>
        </div>
      </div>

      {/* ═══ FULL EDGE FUNCTIONS INVENTORY — full transparency ═══ */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Info className="w-5 h-5 text-primary" />
          <h2 className="font-rubik font-semibold">מצאי מלא — כל Edge Functions במערכת</h2>
          <span className="text-xs px-2 py-0.5 rounded-full bg-info/15 text-info font-medium">22 פונקציות</span>
        </div>
        <p className="text-xs text-muted-foreground">שקיפות מלאה — כל פונקציה פעילה ב-Backend, מה היא עושה, ומאיזה שלב/מסך נקראת.</p>

        {[
          {
            group: 'יצירה ויזואלית / וידאו',
            items: [
              { fn: 'generate-script', actions: 'POST { topic, scenes, duration, aspect_ratio }', desc: 'יצירת תסריט עברי מובנה לסצנות עם הוראות בימוי.', models: 'google/gemini-2.5-flash → google/gemini-2.5-pro → openai/gpt-4o-mini', returns: '{ scenes: [{title, spokenText, visualDescription, duration}] }', notes: 'שרשרת מודלים אוטומטית. אכיפת משך מצטבר. תמיכת RTL מלאה.' },
              { fn: 'enhance-prompt', actions: 'POST { prompt, context }', desc: 'אופטימיזציה של פרומפט המשתמש לפני שימוש במודלים.', models: 'Gemini Flash → Pro → GPT-4o-mini', returns: '{ enhanced_prompt }', notes: 'נקרא ידנית דרך "שפר פרומפט" או אוטומטית בשלב 2 של ה-pipeline.' },
              { fn: 'generate-image', actions: 'POST { prompt, action: "generate"|"edit", imageUrl?, referenceImages?, aspectRatio }', desc: 'יצירת/עריכת תמונות AI עם תמיכה ביחס מסך מפורש.', models: 'google/gemini-3-pro-image-preview', returns: '{ imageUrl, mimeType }', notes: 'aspectRatio נשלח כהוראה מפורשת בעברית למודל (16:9/1:1/9:16). עד 5 תמונות ייחוס.' },
              { fn: 'krea-image', actions: 'POST { action: "generate"|"animate"|"video"|"upscale", prompt, model, width, height, imageUrls?, steps? }', desc: 'יצירת תמונות וידאו ב-Hi-Res דרך פלטפורמת Krea.', models: 'flux, seedream-4 (עד 22K), kling-2.5, veo-3', returns: '{ jobId, status, result_url }', notes: 'polling כל 5 שניות, timeout 3 דק׳ לסטילים, 6 דק׳ לוידאו. fallback של HeyGen.' },
              { fn: 'heygen-video', actions: 'POST { action: "create_video"|"health_check", avatarId, script?, audioUrl, voiceId?, aspectRatio, avatarStyle }', desc: 'יצירת אווטאר מדבר עם סנכרון שפתיים בעברית.', models: 'HeyGen v2 (Photo Avatar + Voice Cloning)', returns: '{ videoUrl, status }', notes: 'דורש audioUrl מ-ElevenLabs (לא טקסט!) לסנכרון שפתיים מיטבי. dimension לפי aspectRatio: 9:16=720x1280, 1:1=720x720, 16:9=1280x720. Timeout: 15 דק׳.' },
              { fn: 'runway-video', actions: 'POST { action: "image_to_video"|"text_to_video"|"get_task", promptText, promptImage?, model, duration, ratio, taskId? }', desc: 'יצירת וידאו AI קולנועי — Fallback בלבד, דורש אישור מפורש.', models: 'gen4.5 (ברירת מחדל)', returns: '{ taskId, status, url }', notes: 'נורמליזציית פרומפט (max chars). דורש activeRunId לדדופ. polling timeout: 5 דק׳. אינו ספק ברירת מחדל.' },
              { fn: 'compose-video', actions: 'POST { timeline: { tracks: [{clips: [...]}] }, output: { format, resolution, fps } }', desc: 'הרכבה ורינדור סופי רב-שכבתי.', models: 'Shotstack (Production)', returns: '{ render_id, status, url, thumbnail }', notes: 'תומך באווטאר + B-roll + כתוביות SVG + עד 2 לוגואים + BGM. Content Rect mapping (יחסי % → פיקסלים, מתעלם מ-letterbox).' },
              { fn: 'generate-avatar', actions: 'POST { name, source_photos[], style, pass_count: 2|3 }', desc: 'יצירת אווטאר חדש עם Identity Lock.', models: 'Gemini 3 Pro Image + variants pipeline', returns: '{ avatar_id, image_url, variants[] }', notes: '2-Pass: זהות + הבעות. 3-Pass: + פיינטיונינג. Pass 1 משמש מקור חוזר לכל ההבעות.' },
              { fn: 'did-avatar', actions: 'POST { action: "create_talk", source_url, audio_url?, script? }', desc: 'גיבוי שני לאווטאר מדבר — D-ID.', models: 'D-ID Talks v1', returns: '{ talk_id, result_url }', notes: 'לא בשימוש כברירת מחדל. שמור לתסריטים בהם HeyGen לא מתאים.' },
            ],
          },
          {
            group: 'קול ואודיו',
            items: [
              { fn: 'text-to-speech', actions: 'POST { text, voice_id, language?, model_id? }', desc: 'קריינות עם קולות ElevenLabs סטנדרטיים.', models: 'eleven_v3 (he), eleven_multilingual_v2 (en/ar)', returns: '{ audio_url, duration }', notes: 'מודל נבחר אוטומטית לפי שפה. צ׳אנקים של 10–20 שניות. נשמר ב-voice_generations.' },
              { fn: 'clone-voice-tts', actions: 'POST { text, provider_voice_id, voice_settings }', desc: 'קריינות עם קול משוכפל אישי של המשתמש.', models: 'eleven_v3 + voice cloning', returns: '{ audio_url, duration, voice_meta }', notes: 'משמש כשנבחר קול עם provider_voice_id מהספרייה. A/B verification של זהות קולית.' },
              { fn: 'transcribe-audio', actions: 'POST { audio_url, language: "he", granularity: "word"|"sentence" }', desc: 'תמלול אודיו לכתוביות עם תזמון מדויק.', models: 'ElevenLabs Scribe v2 (LOCKED)', returns: '{ segments: [{text, start, end, words[]}] }', notes: 'נעול ל-Scribe v2 — אין מעבר ל-v1. רמת מילה לדיוק מקסימלי.' },
              { fn: 'elevenlabs-music', actions: 'POST { action: "music"|"sound_effect", prompt|text, duration_seconds }', desc: 'יצירת מוזיקת רקע או אפקטי קול.', models: 'ElevenLabs Music + SFX', returns: '{ audio_url, duration }', notes: 'duration ברירת מחדל 30 שניות. ducking ב-12dB אוטומטי כאשר יש קריינות.' },
            ],
          },
          {
            group: 'ניהול נכסים (Capability Center)',
            items: [
              { fn: 'avatar-manager', actions: 'POST { action: "list"|"create"|"update"|"delete", id?, payload? }', desc: 'CRUD על ספריית אווטארים.', models: '—', returns: '{ avatars[] } / { avatar }', notes: 'רשימה שטוחה (ללא תיקיות/קולקציות). מגן על תמונה מקורית בעדכון הבעות.' },
              { fn: 'voice-manager', actions: 'POST { action: "list"|"create"|"update"|"delete"|"verify", id?, audio_url? }', desc: 'CRUD על ספריית קולות + verification.', models: '—', returns: '{ voices[] } / { voice }', notes: 'תומך ב-provider_voice_id metadata. A/B verification של זהות בעלייה.' },
              { fn: 'storage-manager', actions: 'POST { action: "upload"|"sign"|"delete"|"list", fileName, fileType, fileBase64? }', desc: 'ניהול מדיה: העלאה, חתימה, מחיקה.', models: '—', returns: '{ url, signed_url, ttl }', notes: 'signed URLs בזמן ריצה. cascade delete כשפרויקט נמחק. bucket: media (public).' },
              { fn: 'import-url', actions: 'POST { url }', desc: 'ייבוא מדיה מ-URL ישיר.', models: '—', returns: '{ media_url, type, size }', notes: 'HEAD timeout 10s, DOWNLOAD timeout 5 דק׳. איסור פלטפורמות מוגנות (YouTube/Instagram/TikTok).' },
            ],
          },
          {
            group: 'תוכן וטרנדים',
            items: [
              { fn: 'firecrawl-scrape', actions: 'POST { url, formats: ["markdown"|"html"] }', desc: 'סריקת אתרים ראשית (Firecrawl).', models: 'Firecrawl v1', returns: '{ markdown, html, metadata }', notes: 'timeout 20 שנ׳ למיפוי, 12 שנ׳ לסקרייפ. הספק הראשון.' },
              { fn: 'scrape-website-content', actions: 'POST { url }', desc: 'סריקת אתרים גיבוי (Gemini Flash).', models: 'google/gemini-2.5-flash', returns: '{ content, title, summary }', notes: 'fallback כש-Firecrawl לא זמין. timeout 15 שנ׳.' },
              { fn: 'fetch-trends', actions: 'POST { industry, category? }', desc: 'משיכת טרנדים ויראליים on-demand.', models: 'Perplexity sonar-large', returns: '{ trends: [{title, platform, url, views, summary, tip, visual_style}] }', notes: 'בדיוק 10 פוסטים מהשבוע האחרון. רק רשתות חברתיות (לא חדשות).' },
              { fn: 'auto-fetch-trends', actions: 'POST { category? } (cron-triggered)', desc: 'משיכת טרנדים אוטומטית מתוזמנת.', models: 'Perplexity sonar-large', returns: '{ inserted_count }', notes: 'רץ דרך pg_cron כל יומיים. שומר ל-saved_trends. הפעולה האוטומטית היחידה במערכת.' },
            ],
          },
          {
            group: 'תשתית, אבטחה ובקרת עלות',
            items: [
              { fn: 'check-credits', actions: 'POST {}', desc: 'בדיקת readiness מפורטת לכל ספק.', models: '—', returns: '{ credits: [{service, readiness, authValid, creditsAvailable, modelsAccessible, liveGenerationPassed, used, limit, statusLabel, lastFailureReason}] }', notes: 'timeout 25 שנ׳ לבדיקה. readiness: generation_verified / credits_ok / authenticated / connected / blocked_credits / blocked_env / auth_failed / error / not_configured.' },
              { fn: 'provider-balances', actions: 'POST {}', desc: 'יתרות בזמן אמת לכל הספקים.', models: '—', returns: '{ providers: {id: {ok, remaining, total, used, unit, resetAt, reason}}, updatedAt }', notes: 'timeout 15 שנ׳ לספק. auto-refresh בכל 5 דקות מהפרונט. unknown לא חוסם.' },
              { fn: 'auth-gate', actions: 'POST { action: "verify", username, password }', desc: 'שער כניסה פרטי לאפליקציה.', models: '—', returns: '{ token, expiresAt }', notes: 'אימות מול GATE_USERNAME/GATE_PASSWORD (secrets). session 24 שעות. localStorage על המשתמש.' },
              { fn: 'data-manager', actions: 'POST { action: "setup"|"list_brands"|...|"insert"|"update", data? }', desc: 'גישה מבוקרת לטבלאות (CRUD מאוחד).', models: '—', returns: '{ data } / { success }', notes: 'RLS-aware. מרכז את כל פעולות ה-DB מצד הלקוח דרך פונקציה מאומתת.' },
            ],
          },
        ].map((group) => (
          <div key={group.group} className="space-y-2">
            <h3 className="text-xs font-semibold text-primary border-b border-border/40 pb-1">{group.group}</h3>
            <ul className="space-y-2">
              {group.items.map((item) => (
                <li key={item.fn} className="bg-muted/20 border border-border/40 rounded-lg p-2.5 space-y-1.5">
                  <div className="flex items-start gap-2 flex-wrap">
                    <code className="flex-shrink-0 px-1.5 py-0.5 rounded bg-primary/10 text-primary font-mono text-[11px] font-bold">{item.fn}</code>
                    <span className="text-[11px] text-foreground flex-1">{item.desc}</span>
                  </div>
                  <div className="grid grid-cols-1 gap-1 text-[10.5px] pl-1 border-r-2 border-primary/20 pr-2">
                    <p><strong className="text-primary">Endpoint:</strong> <code className="text-muted-foreground font-mono text-[10px]">{item.actions}</code></p>
                    {item.models !== '—' && <p><strong className="text-primary">מודלים:</strong> <span className="text-muted-foreground font-mono text-[10px]">{item.models}</span></p>}
                    <p><strong className="text-primary">מחזיר:</strong> <code className="text-muted-foreground font-mono text-[10px]">{item.returns}</code></p>
                    <p><strong className="text-warning">הערות:</strong> <span className="text-muted-foreground">{item.notes}</span></p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div className="space-y-2 pt-2 border-t border-border/40">
          <h3 className="text-xs font-semibold text-primary">תשתית — טבלאות DB ופעולות רקע</h3>
          <ul className="space-y-1.5 text-[11px] text-muted-foreground">
            <li><strong className="text-foreground">10 טבלאות:</strong> projects, project_outputs, project_versions, project_timeline, avatars, voices, voice_generations, scripts, brands, saved_trends</li>
            <li><strong className="text-foreground">RLS:</strong> כל הטבלאות מוגנות (Row Level Security) — משתמש רואה רק את הנתונים שלו</li>
            <li><strong className="text-foreground">Triggers:</strong> trigger יחיד פעיל — <code className="px-1 bg-muted rounded">projects_updated_at</code> (עדכון אוטומטי של זמן עריכה)</li>
            <li><strong className="text-foreground">פעולות רקע מתוזמנות:</strong> <code className="px-1 bg-muted rounded">auto-fetch-trends</code> (pg_cron כל יומיים) — הפעולה היחידה שרצה אוטומטית ללא טריגר משתמש</li>
            <li><strong className="text-foreground">אחסון:</strong> Supabase Storage עם signed URLs (פג תוקף בזמן ריצה), cascade delete</li>
            <li><strong className="text-foreground">JWT:</strong> 22 פונקציות עם <code className="px-1 bg-muted rounded">verify_jwt=false</code> + הגנת auth-gate (12345/12345, 24 שעות)</li>
          </ul>
        </div>

        <div className="bg-success/5 border border-success/20 rounded-lg p-3 space-y-1.5">
          <p className="text-[11px] text-foreground"><strong className="text-success">הצהרת שקיפות מלאה:</strong></p>
          <ul className="text-[11px] text-foreground space-y-0.5 list-disc list-inside">
            <li>22 Edge Functions — כולן מתועדות למעלה לפי שם וייעוד</li>
            <li>10 טבלאות DB — כולן מוצגות, כולן עם RLS</li>
            <li>פעולה מתוזמנת אחת בלבד (auto-fetch-trends כל יומיים)</li>
            <li>אין קריאות AI נסתרות, אין שליחת נתונים לצדדים שלישיים מעבר לספקים שמוצגים בכרטיסי הספקים למטה</li>
            <li>כל פעולה בתשלום חוסמת את עצמה עד אישור מפורש (CostApprovalDialog)</li>
            <li>הכל ניתן לבדיקה E2E דרך <code className="px-1 bg-muted rounded">/proof-test</code></li>
          </ul>
        </div>
      </div>
      {/* ═══ PROVIDER STATUS CARDS ═══ */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h2 className="font-rubik font-semibold">מצב ספקים</h2>
            <div className="flex items-center gap-2">
              {verifiedCount > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-success/15 text-success font-medium flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> {verifiedCount} אומתו
                </span>
              )}
              {warningCount > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-warning/15 text-warning font-medium flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> {warningCount} לא אומתו
                </span>
              )}
              {blockedCount > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-destructive/15 text-destructive font-medium flex items-center gap-1">
                  <ShieldX className="w-3 h-3" /> {blockedCount} חסומים
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {balanceUpdatedAt && <span className="text-xs text-muted-foreground">יתרות עודכנו {formatTimeAgo(balanceUpdatedAt)}</span>}
            <button onClick={() => { loadCredits(); loadBalances(); }} disabled={loading || balanceLoading}
              className="text-xs px-3 py-1.5 border border-border rounded-lg hover:bg-muted flex items-center gap-1.5 transition-colors">
              {(loading || balanceLoading) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              רענן הכל
            </button>
          </div>
        </div>

        <div className="space-y-3">
          {serviceConfig.map(s => (
            <ServiceCard key={s.id} config={s} Icon={s.icon} credit={credits[s.id]}
              balance={s.balanceKey ? balances[s.balanceKey] : undefined}
              loading={loading} balanceLoading={balanceLoading}
              getUsagePercent={getUsagePercent} getUsageColor={getUsageColor}
              onRefreshBalance={loadBalances} />
          ))}
        </div>

        <p className="text-xs text-muted-foreground mt-4">
          💡 בדיקת ספקים ויתרות משתמשת רק בקריאות אימות/מכסה — ללא יצירות, ללא שריפת קרדיטים. רענון אוטומטי כל 5 דקות.
        </p>
      </div>
    </div>
  );
}

function ServiceCard({ config: s, Icon, credit, balance, loading, balanceLoading, getUsagePercent, getUsageColor, onRefreshBalance }: {
  config: ProviderMeta; Icon: any; credit?: ProviderStatus; balance?: BalanceResult;
  loading: boolean; balanceLoading: boolean;
  getUsagePercent: (c: ProviderStatus) => number; getUsageColor: (p: number, can: boolean) => string;
  onRefreshBalance: () => void;
}) {
  const readiness = credit?.readiness || (s.free ? 'credits_ok' : 'not_configured');
  const rConfig = readinessColors[readiness] || readinessColors.not_configured;
  const StatusIcon = rConfig.icon;
  const rBadge = roleBadge[s.role];

  return (
    <div className={cn(
      "p-4 rounded-lg border space-y-3 transition-colors",
      s.blockedManually ? "bg-destructive/5 border-destructive/30"
        : readiness === 'blocked_credits' || readiness === 'auth_failed' ? "bg-destructive/5 border-destructive/30"
        : readiness === 'authenticated' || readiness === 'blocked_env' ? "bg-warning/5 border-warning/30"
        : "bg-muted/30 border-border"
    )}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={cn("w-10 h-10 rounded-full flex items-center justify-center", rConfig.bg, rConfig.text)}>
            <StatusIcon className="w-5 h-5" />
          </div>
          <div>
            <p className="text-sm font-medium flex items-center gap-2">
              <Icon className="w-4 h-4 text-primary" /> {s.name}
            </p>
            <p className="text-xs text-muted-foreground">{s.desc}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", rBadge.bg, rBadge.text)}>
            {s.role}
          </span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            {s.category}
          </span>
          <span className={cn("text-xs px-2.5 py-1 rounded-full font-medium flex items-center gap-1", rConfig.bg, rConfig.text,
            (readiness === 'blocked_credits' || readiness === 'auth_failed' || s.blockedManually) && "animate-pulse"
          )}>
            <StatusIcon className="w-3 h-3" />
            {credit?.statusLabel || (s.free ? 'פעיל' : s.blockedManually ? 'חסום ידנית' : 'לא מוגדר')}
          </span>
        </div>
      </div>

      {/* ═══ BALANCE / QUOTA ROW ═══ */}
      {s.balanceKey && (
        <div className="mr-13 bg-card border border-border rounded-lg p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Coins className="w-4 h-4 text-primary" />
              <span className="text-xs font-semibold">יתרת קרדיטים:</span>
              {balanceLoading && !balance ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" /> טוען...</span>
              ) : balance ? (
                balance.remaining !== null ? (
                  <span className={cn("text-sm font-bold", balance.remaining === 0 ? "text-destructive" : balance.remaining < 100 ? "text-warning" : "text-success")}>
                    {typeof balance.remaining === 'number' ? balance.remaining.toLocaleString() : balance.remaining}
                    <span className="text-xs font-normal text-muted-foreground mr-1">{balance.unit}</span>
                    {balance.total !== null && (
                      <span className="text-xs font-normal text-muted-foreground"> / {balance.total.toLocaleString()}</span>
                    )}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Info className="w-3 h-3" /> לא ידוע
                    {balance.reason && <span className="text-[10px]">({balance.reason})</span>}
                  </span>
                )
              ) : (
                <span className="text-xs text-muted-foreground">לא נבדק</span>
              )}
            </div>
            <button onClick={() => onRefreshBalance()} disabled={balanceLoading}
              className="text-[10px] px-2 py-1 border border-border rounded hover:bg-muted flex items-center gap-1 transition-colors">
              {balanceLoading ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RefreshCw className="w-2.5 h-2.5" />}
              רענן
            </button>
          </div>
          {/* Balance bar when we have numeric data */}
          {balance && balance.remaining !== null && balance.total !== null && balance.total > 0 && (
            <div className="mt-2 space-y-1">
              <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                <div className={cn("h-full rounded-full transition-all duration-500",
                  balance.remaining === 0 ? "bg-destructive" : (balance.remaining / balance.total) < 0.2 ? "bg-warning" : "bg-success"
                )} style={{ width: `${Math.min(100, Math.round(((balance.total - (balance.used ?? 0)) / balance.total) * 100))}%` }} />
              </div>
            </div>
          )}
          {balance?.resetAt && (
            <p className="text-[10px] text-muted-foreground mt-1">איפוס: {new Date(balance.resetAt).toLocaleDateString('he-IL')} {new Date(balance.resetAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</p>
          )}
        </div>
      )}

      {/* Operational labels row */}
      <div className="mr-13 flex flex-wrap gap-1.5">
        {s.safeForGeneration && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-success/10 text-success font-medium">🟢 בטוח לשימוש</span>
        )}
        {s.blockedManually && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-destructive/10 text-destructive font-medium">🔴 חסום ידנית</span>
        )}
        {s.safeForGeneration && !s.blockedManually && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">✅ זמין ליצירה</span>
        )}
        {!s.safeForGeneration && !s.blockedManually && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">⚪ לא זמין כרגע</span>
        )}
        {s.requiresApproval && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-warning/10 text-warning font-medium">⚠️ דורש אישור ידני</span>
        )}
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">🔒 לא מבצע יצירה אוטומטית</span>
      </div>

      {/* Validation checklist */}
      {credit && (
        <div className="mr-13 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <ChecklistItem label="אימות" value={credit.authValid} />
          <ChecklistItem label="קרדיטים" value={credit.creditsAvailable} />
          <ChecklistItem label="מודלים" value={credit.modelsAccessible} />
          <ChecklistItem label="יצירה חיה" value={credit.liveGenerationPassed} />
        </div>
      )}

      {/* Credits bar */}
      {s.hasCredits && credit && !credit.error && credit.limit > 0 && (
        <div className="mr-13 space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">שימוש: {credit.used} / {credit.limit} {credit.unit}</span>
            <span className={cn("font-medium", credit.canGenerate ? "text-foreground" : "text-destructive")}>{getUsagePercent(credit)}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
            <div className={cn("h-full rounded-full transition-all duration-500", getUsageColor(getUsagePercent(credit), credit.canGenerate))}
              style={{ width: `${getUsagePercent(credit)}%` }} />
          </div>
        </div>
      )}

      {/* Billing / Cost info */}
      <div className="mr-13 bg-muted/20 rounded-lg p-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <span className="flex items-center gap-1 text-muted-foreground"><DollarSign className="w-3 h-3" /> {s.billingType}</span>
        <span className="text-muted-foreground">עלות חודשית: <strong className="text-foreground">{s.monthlyCost}</strong></span>
        {s.extraCreditsNeeded && <span className="text-warning">⚠️ נדרשים קרדיטים נוספים</span>}
        <span className="text-muted-foreground">{s.costConfirmed ? '✅ מאומת מהספק' : 'ℹ️ הזנה ידנית'}</span>
      </div>

      {/* Failure reason */}
      {credit?.lastFailureReason && (
        <div className="mr-13">
          <p className="text-xs text-warning bg-warning/10 rounded-lg px-3 py-2 break-all">
            ⚠️ {credit.lastFailureReason}
          </p>
        </div>
      )}

      {/* Error state */}
      {credit?.error && !credit.lastFailureReason && (
        <div className="mr-13">
          <p className="text-xs text-warning bg-warning/10 rounded-lg px-3 py-2">⚠️ {credit.error}</p>
        </div>
      )}

      {/* Loading */}
      {s.hasCredits && loading && !credit && (
        <div className="mr-13 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> בודק ספק...
        </div>
      )}

      {/* Dashboard */}
      {s.hasCredits && credit?.dashboardUrl && (
        <div className="mr-13">
          <a href={credit.dashboardUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline">
            <ExternalLink className="w-3 h-3" /> ניהול חשבון ושדרוג
          </a>
        </div>
      )}
    </div>
  );
}

function ChecklistItem({ label, value }: { label: string; value: boolean | null | undefined }) {
  if (value === null || value === undefined) {
    return <span className="flex items-center gap-1 text-muted-foreground">⬜ {label}</span>;
  }
  return value
    ? <span className="flex items-center gap-1 text-success">✅ {label}</span>
    : <span className="flex items-center gap-1 text-destructive">❌ {label}</span>;
}
