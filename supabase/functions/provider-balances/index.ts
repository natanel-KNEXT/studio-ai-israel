const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface BalanceResult {
  ok: boolean;
  remaining: number | null;
  total: number | null;
  used: number | null;
  unit: string;
  resetAt?: string | null;
  reason?: string;
}

const TIMEOUT_MS = 15_000;

async function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  let tid: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => {
      tid = setTimeout(() => rej(new Error(`${label}: timeout ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    }),
  ]).finally(() => { if (tid) clearTimeout(tid); });
}

function unknown(unit: string, reason: string): BalanceResult {
  return { ok: false, remaining: null, total: null, used: null, unit, reason };
}

/* ── ElevenLabs ── */
async function checkElevenLabs(apiKey: string): Promise<BalanceResult> {
  const headers = { "xi-api-key": apiKey };
  // Try subscription endpoint first
  const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers });
  if (res.status === 401 || res.status === 403) return unknown("תווים", "מפתח API לא תקין");
  if (!res.ok) {
    // Fallback to /v1/user
    const userRes = await fetch("https://api.elevenlabs.io/v1/user", { headers });
    if (!userRes.ok) return unknown("תווים", `HTTP ${userRes.status}`);
    const ud = await userRes.json();
    const sub = ud?.subscription;
    if (!sub) return unknown("תווים", "אימות תקין אבל אין נתוני מנוי");
    const used = sub.character_count ?? 0;
    const limit = sub.character_limit ?? 0;
    return { ok: true, remaining: Math.max(0, limit - used), total: limit, used, unit: "תווים", resetAt: sub.next_character_count_reset_unix ? new Date(sub.next_character_count_reset_unix * 1000).toISOString() : null };
  }
  const d = await res.json();
  const used = d.character_count ?? 0;
  const limit = d.character_limit ?? 0;
  return { ok: true, remaining: Math.max(0, limit - used), total: limit, used, unit: "תווים", resetAt: d.next_character_count_reset_unix ? new Date(d.next_character_count_reset_unix * 1000).toISOString() : null };
}

/* ── HeyGen ── */
async function checkHeyGen(apiKey: string): Promise<BalanceResult> {
  const headers = { "X-Api-Key": apiKey };
  // v2 quota
  const res = await fetch("https://api.heygen.com/v2/user/remaining_quota", { headers });
  if (res.status === 401 || res.status === 403) return unknown("קרדיטים", "מפתח API לא תקין");
  if (res.ok) {
    const d = await res.json();
    let remaining = d?.data?.remaining_quota ?? -1;
    if (remaining < 0 && d?.data?.details) {
      const det = d.data.details;
      remaining = det.remaining_quota ?? ((det.api ?? 0) + (det.plan_credit ?? 0));
    }
    if (remaining >= 0) return { ok: true, remaining, total: null, used: null, unit: "קרדיטים" };
  }
  // v1 fallback
  const v1 = await fetch("https://api.heygen.com/v1/user/remaining_quota", { headers });
  if (v1.ok) {
    const d = await v1.json();
    const remaining = d?.data?.remaining_quota ?? d?.remaining_quota ?? -1;
    if (remaining >= 0) return { ok: true, remaining, total: null, used: null, unit: "קרדיטים" };
  }
  return unknown("קרדיטים", "אימות תקין אבל endpoint הקרדיטים לא החזיר ערך");
}

/* ── Runway ── */
async function checkRunway(apiKey: string): Promise<BalanceResult> {
  // Runway API does NOT expose a safe balance/quota endpoint.
  // Auth-only check via nonexistent task.
  const res = await fetch("https://api.dev.runwayml.com/v1/tasks/00000000-0000-0000-0000-000000000000", {
    headers: { Authorization: `Bearer ${apiKey}`, "X-Runway-Version": "2024-11-06" },
  });
  if (res.status === 401 || res.status === 403) return unknown("קרדיטים", "מפתח API לא תקין");
  return unknown("קרדיטים", "Runway API לא חושף יתרת קרדיטים דרך endpoint בטוח");
}

/* ── Krea ── */
async function checkKrea(apiKey: string): Promise<BalanceResult> {
  const res = await fetch("https://api.krea.ai/user/me", { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status === 401 || res.status === 403) return unknown("קרדיטים", "מפתח API לא תקין");
  if (res.ok) {
    try {
      const d = await res.json();
      // Krea may return credits info in user profile
      if (d?.credits !== undefined) {
        return { ok: true, remaining: d.credits, total: null, used: null, unit: "קרדיטים" };
      }
      if (d?.balance !== undefined) {
        return { ok: true, remaining: d.balance, total: null, used: null, unit: "קרדיטים" };
      }
    } catch {}
  }
  return unknown("קרדיטים", "אימות תקין אבל Krea API לא החזיר נתוני יתרה");
}

/* ── Shotstack ── */
async function checkShotstack(apiKey: string): Promise<BalanceResult> {
  // Shotstack doesn't have a safe balance endpoint — only render list
  const res = await fetch("https://api.shotstack.io/v1/render", { method: "GET", headers: { "x-api-key": apiKey } });
  if (res.status === 401 || res.status === 403) return unknown("רינדורים", "מפתח API לא תקין");
  // Auth works but no quota data
  return unknown("רינדורים", "Shotstack API לא חושף יתרת רינדורים דרך endpoint בטוח — חיוב לפי שימוש");
}

/* ── Cloudinary ── */
async function checkCloudinary(cloudName: string, apiKey: string, apiSecret: string): Promise<BalanceResult> {
  const auth = btoa(`${apiKey}:${apiSecret}`);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/usage`, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) return unknown("% שימוש", `HTTP ${res.status}`);
  const d = await res.json();
  const usedPct = d.credits?.used_percent ?? 0;
  return { ok: true, remaining: Math.round((100 - usedPct) * 100) / 100, total: 100, used: Math.round(usedPct * 100) / 100, unit: "% מהמכסה" };
}

/* ── Lovable AI ── */
async function checkLovableAI(apiKey: string): Promise<BalanceResult> {
  // Lovable AI gateway doesn't expose a safe balance endpoint.
  // A minimal ping costs credits. We only check auth via a tiny request.
  // The 402 response confirms credits exhausted.
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "google/gemini-2.5-flash-lite", messages: [{ role: "user", content: "1" }], max_tokens: 1 }),
  });
  if (res.status === 401 || res.status === 403) return unknown("בקשות", "מפתח API לא תקין");
  if (res.status === 402) return { ok: true, remaining: 0, total: null, used: null, unit: "בקשות", reason: "קרדיטים נגמרו" };
  if (res.status === 429) return unknown("בקשות", "מוגבל זמנית (rate limit) — הקרדיטים כנראה תקינים");
  if (res.ok) return unknown("בקשות", "Lovable AI לא חושף מספר קרדיטים מדויק — הספק פעיל ותקין");
  return unknown("בקשות", `HTTP ${res.status}`);
}

/* ── Main ── */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const results: Record<string, BalanceResult> = {};

    const elevenLabsKey = Deno.env.get("ELEVENLABS_API_KEY");
    const heygenKey = Deno.env.get("HEYGEN_API_KEY");
    const runwayKey = Deno.env.get("RUNWAY_API_KEY");
    const shotstackKey = Deno.env.get("SHOTSTACK_API_KEY");
    const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
    const cloudKey = Deno.env.get("CLOUDINARY_API_KEY");
    const cloudSecret = Deno.env.get("CLOUDINARY_API_SECRET");
    const kreaKey = Deno.env.get("KREA_API_KEY");
    const lovableKey = Deno.env.get("LOVABLE_API_KEY");

    const tasks: [string, Promise<BalanceResult>][] = [];
    if (elevenLabsKey) tasks.push(["elevenlabs", withTimeout(checkElevenLabs(elevenLabsKey), "elevenlabs")]);
    if (heygenKey) tasks.push(["heygen", withTimeout(checkHeyGen(heygenKey), "heygen")]);
    if (runwayKey) tasks.push(["runway", withTimeout(checkRunway(runwayKey), "runway")]);
    if (shotstackKey) tasks.push(["shotstack", withTimeout(checkShotstack(shotstackKey), "shotstack")]);
    if (cloudName && cloudKey && cloudSecret) tasks.push(["cloudinary", withTimeout(checkCloudinary(cloudName, cloudKey, cloudSecret), "cloudinary")]);
    if (kreaKey) tasks.push(["krea", withTimeout(checkKrea(kreaKey), "krea")]);
    if (lovableKey) tasks.push(["lovable_ai", withTimeout(checkLovableAI(lovableKey), "lovable_ai")]);

    const settled = await Promise.allSettled(tasks.map(([, p]) => p));
    for (let i = 0; i < tasks.length; i++) {
      const [name] = tasks[i];
      const result = settled[i];
      results[name] = result.status === "fulfilled" ? result.value : unknown("", result.reason?.message || "שגיאה לא צפויה");
    }

    return new Response(JSON.stringify({ updatedAt: new Date().toISOString(), providers: results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
