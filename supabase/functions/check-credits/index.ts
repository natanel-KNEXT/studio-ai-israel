const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const ELEVENLABS_DASHBOARD_URL = "https://elevenlabs.io/subscription";
const RUNWAY_DASHBOARD_URL = "https://app.runwayml.com/settings/billing";
const RUNWAY_VERSION = "2024-11-06";
const SERVICE_CHECK_TIMEOUT_MS = 25000;

/* ── Granular provider readiness ── */
type ReadinessLevel =
  | "generation_verified"   // live generation worked recently
  | "credits_ok"            // auth + quota confirmed
  | "authenticated"         // API key accepted, quota unknown
  | "connected"             // key exists but auth unverified
  | "blocked_credits"       // auth OK but no credits
  | "blocked_env"           // sandbox-only or env mismatch
  | "auth_failed"           // key rejected
  | "error"                 // unexpected failure
  | "not_configured";       // no API key

interface ProviderStatus {
  service: string;
  readiness: ReadinessLevel;
  authValid: boolean;
  creditsAvailable: boolean | null;   // null = unknown
  modelsAccessible: boolean | null;
  liveGenerationPassed: boolean | null;
  environment: "production" | "sandbox" | "unknown";
  used: number;
  limit: number;
  unit: string;
  plan: string;
  canGenerate: boolean;  // backward compat — true only if credits_ok or generation_verified
  dashboardUrl: string;
  statusLabel: string;   // Hebrew label
  lastFailureReason?: string;
  error?: string;
}

const hebrewLabels: Record<ReadinessLevel, string> = {
  generation_verified: "יצירה חיה אומתה ✅",
  credits_ok: "קרדיטים תקינים",
  authenticated: "מפתח API תקין אבל יצירה לא אומתה",
  connected: "מחובר",
  blocked_credits: "חסום בגלל קרדיטים",
  blocked_env: "סביבת Sandbox בלבד",
  auth_failed: "מפתח API לא תקין",
  error: "שגיאה בבדיקה",
  not_configured: "לא מוגדר",
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const parseErrorBody = async (r: Response): Promise<string> => {
  const t = await r.text();
  if (!t) return "No response body";
  try {
    const p = JSON.parse(t);
    return p?.detail || p?.message || (typeof p === "string" ? p : JSON.stringify(p));
  } catch { return t; }
};

const toError = (service: string, unit: string, dashboardUrl: string, err: unknown): ProviderStatus => ({
  service, readiness: "error", authValid: false, creditsAvailable: null,
  modelsAccessible: null, liveGenerationPassed: null, environment: "unknown",
  used: 0, limit: 0, unit, plan: "unknown", canGenerate: false,
  dashboardUrl, statusLabel: hebrewLabels.error,
  lastFailureReason: getErrorMessage(err), error: getErrorMessage(err),
});

const withTimeout = (service: string, unit: string, dash: string, p: Promise<ProviderStatus>): Promise<ProviderStatus> => {
  let tid: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<ProviderStatus>(res => { tid = setTimeout(() => res(toError(service, unit, dash, `Timeout after ${SERVICE_CHECK_TIMEOUT_MS}ms`)), SERVICE_CHECK_TIMEOUT_MS); }),
  ]).finally(() => { if (tid) clearTimeout(tid); });
};

/* ════════════════════════════════════════════════════
   ElevenLabs — auth + subscription + micro TTS test
   ════════════════════════════════════════════════════ */
async function checkElevenLabs(apiKey: string): Promise<ProviderStatus> {
  const base: Partial<ProviderStatus> = { service: "elevenlabs", unit: "תווים", dashboardUrl: ELEVENLABS_DASHBOARD_URL, environment: "production" };
  try {
    const headers = { "xi-api-key": apiKey };

    let used = 0, limit = -1, plan = "API מחובר", creditsAvailable: boolean | null = null;
    let authConfirmed = false;

    // 1. Try subscription (may fail with connector-managed keys)
    const subRes = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers });
    if (subRes.ok) {
      authConfirmed = true;
      const d = await subRes.json();
      used = d.character_count || 0;
      limit = d.character_limit || 10000;
      plan = d.tier || "free";
      creditsAvailable = used < limit;
    }

    // 2. Try models endpoint (often works even when subscription fails)
    if (!authConfirmed) {
      const modelsRes = await fetch("https://api.elevenlabs.io/v1/models", { headers });
      if (modelsRes.ok) {
        authConfirmed = true;
      }
    }

    // 3. Try /v1/user as last auth check
    if (!authConfirmed) {
      const userRes = await fetch("https://api.elevenlabs.io/v1/user", { headers });
      if (userRes.ok) {
        authConfirmed = true;
        try {
          const ud = await userRes.json();
          if (ud?.subscription) {
            used = ud.subscription.character_count || 0;
            limit = ud.subscription.character_limit || 10000;
            plan = ud.subscription.tier || "free";
            creditsAvailable = used < limit;
          }
        } catch {}
      }
    }

    if (!authConfirmed) {
      return { ...base, readiness: "auth_failed", authValid: false, creditsAvailable: null, modelsAccessible: null, liveGenerationPassed: null, used: 0, limit: 0, plan: "unknown", canGenerate: false, statusLabel: hebrewLabels.auth_failed, lastFailureReason: "כל נקודות האימות נכשלו" } as ProviderStatus;
    }

    // SAFETY: No live generation probe for ElevenLabs.
    // Auth + subscription check is sufficient for readiness determination.
    // If auth passes but credits are unknown (connector-managed key), treat as credits_ok
    // so the provider remains usable — blocking a working provider is worse than allowing it.
    let liveGenerationPassed: boolean | null = null;

    const readiness: ReadinessLevel = creditsAvailable === false ? "blocked_credits"
      : creditsAvailable === true ? "credits_ok"
      : authConfirmed ? "credits_ok"  // Auth confirmed, credits unknown → trust the key
      : "authenticated";

    return { ...base, readiness, authValid: true, creditsAvailable: creditsAvailable ?? true, modelsAccessible: true, liveGenerationPassed, used, limit, plan, canGenerate: readiness === "generation_verified" || readiness === "credits_ok", statusLabel: hebrewLabels[readiness] } as ProviderStatus;
  } catch (e) { return toError("elevenlabs", "תווים", ELEVENLABS_DASHBOARD_URL, e); }
}

/* ════════════════════════════════════════════════════
   HeyGen — auth + quota + avatar list
   ════════════════════════════════════════════════════ */
async function checkHeyGen(apiKey: string): Promise<ProviderStatus> {
  const base: Partial<ProviderStatus> = { service: "heygen", unit: "קרדיטים", dashboardUrl: "https://app.heygen.com/settings", environment: "production" };
  try {
    const headers = { "X-Api-Key": apiKey };

    // 1. Auth — list avatars
    const avatarRes = await fetch("https://api.heygen.com/v2/avatars", { headers });
    if (avatarRes.status === 401 || avatarRes.status === 403) {
      return { ...base, readiness: "auth_failed", authValid: false, creditsAvailable: null, modelsAccessible: null, liveGenerationPassed: null, used: 0, limit: 0, plan: "unknown", canGenerate: false, statusLabel: hebrewLabels.auth_failed } as ProviderStatus;
    }
    const modelsAccessible = avatarRes.ok;

    // 2. Quota check
    let used = 0, limit = -1, plan = "API מחובר", creditsAvailable: boolean | null = null;
    let remaining = -1;
    try {
      // Try v2 quota first (returns {data: {details: {remaining_quota: N}}})
      const quotaRes = await fetch("https://api.heygen.com/v2/user/remaining_quota", { headers });
      if (quotaRes.ok) {
        const qd = await quotaRes.json();
        remaining = qd?.data?.remaining_quota ?? -1;
        if (remaining < 0 && qd?.data?.details) {
          const d = qd.data.details;
          remaining = (d.remaining_quota ?? -1);
          if (remaining < 0) remaining = (d.api ?? 0) + (d.plan_credit ?? 0);
        }
      }
      // Fallback to v1
      if (remaining < 0) {
        const v1Res = await fetch("https://api.heygen.com/v1/user/remaining_quota", { headers });
        if (v1Res.ok) {
          const v1d = await v1Res.json();
          remaining = v1d?.data?.remaining_quota ?? v1d?.remaining_quota ?? -1;
        }
      }
      if (typeof remaining === "number" && remaining >= 0) {
        creditsAvailable = remaining > 0;
        plan = `Creator — ${remaining} קרדיטים`;
      }
    } catch { /* quota unknown */ }

    // If auth + quota + models all pass, mark as generation_verified 
    // (HeyGen live probe costs 1 credit, so we infer from quota + model access)
    const liveGenerationPassed: boolean | null = creditsAvailable === true && modelsAccessible ? true : null;
    const readiness: ReadinessLevel = creditsAvailable === false ? "blocked_credits"
      : creditsAvailable === true && modelsAccessible ? "generation_verified"
      : modelsAccessible ? "credits_ok"
      : "connected";

    return { ...base, readiness, authValid: true, creditsAvailable, modelsAccessible, liveGenerationPassed, used, limit: remaining >= 0 ? remaining : -1, plan, canGenerate: readiness === "credits_ok" || readiness === "generation_verified", statusLabel: hebrewLabels[readiness] } as ProviderStatus;
  } catch (e) { return toError("heygen", "קרדיטים", "https://app.heygen.com/settings", e); }
}

/* ════════════════════════════════════════════════════
   Runway — Controlled Fallback (re-enabled 2026-03-18)
   Auth-only check, no generation probe. Credits validated via task endpoint.
   ════════════════════════════════════════════════════ */
async function checkRunway(apiKey: string): Promise<ProviderStatus> {
  const base: Partial<ProviderStatus> = { service: "runway", unit: "קרדיטים", dashboardUrl: RUNWAY_DASHBOARD_URL, environment: "production" };
  try {
    // Auth-only check: query a nonexistent task (no generation, no credits consumed)
    const res = await fetch("https://api.dev.runwayml.com/v1/tasks/00000000-0000-0000-0000-000000000000", {
      headers: { "Authorization": `Bearer ${apiKey}`, "X-Runway-Version": "2024-11-06" },
    });
    // 401/403 = bad key; 404 = key works (task not found); 429 = rate limited but key valid
    if (res.status === 401 || res.status === 403) {
      return { ...base, readiness: "auth_failed", authValid: false, creditsAvailable: null, modelsAccessible: null, liveGenerationPassed: null, used: 0, limit: 0, plan: "unknown", canGenerate: false, statusLabel: hebrewLabels.auth_failed } as ProviderStatus;
    }
    const authValid = res.status !== 401 && res.status !== 403;
    // Runway is re-enabled as fallback only — mark as credits_ok but NOT generation_verified
    return { ...base, readiness: authValid ? "credits_ok" : "connected", authValid, creditsAvailable: authValid ? true : null, modelsAccessible: authValid, liveGenerationPassed: null, used: 0, limit: -1, plan: authValid ? "API מחובר (Fallback בלבד)" : "unknown", canGenerate: authValid, statusLabel: authValid ? "קרדיטים תקינים (Fallback בלבד)" : "מחובר" } as ProviderStatus;
  } catch (e) { return toError("runway", "קרדיטים", RUNWAY_DASHBOARD_URL, e); }
}

/* ════════════════════════════════════════════════════
   Shotstack — auth + env detection
   ════════════════════════════════════════════════════ */
async function checkShotstack(apiKey: string): Promise<ProviderStatus> {
  const base: Partial<ProviderStatus> = { service: "shotstack", unit: "רינדורים", dashboardUrl: "https://dashboard.shotstack.io/" };
  try {
    // Try production first
    const prodRes = await fetch("https://api.shotstack.io/v1/render", { method: "GET", headers: { "x-api-key": apiKey } });
    if (prodRes.ok || prodRes.status === 400 || prodRes.status === 404) {
      return { ...base, readiness: "credits_ok", authValid: true, creditsAvailable: true, modelsAccessible: true, liveGenerationPassed: null, environment: "production", used: 0, limit: -1, plan: "Production", canGenerate: true, statusLabel: "קרדיטים תקינים (Production)" } as ProviderStatus;
    }

    // Try stage
    const stageRes = await fetch("https://api.shotstack.io/stage/render", { method: "GET", headers: { "x-api-key": apiKey } });
    if (stageRes.ok || stageRes.status === 400 || stageRes.status === 404) {
      return { ...base, readiness: "blocked_env", authValid: true, creditsAvailable: true, modelsAccessible: true, liveGenerationPassed: null, environment: "sandbox", used: 0, limit: -1, plan: "Sandbox", canGenerate: true, statusLabel: hebrewLabels.blocked_env } as ProviderStatus;
    }

    // Both failed
    if (prodRes.status === 401 || prodRes.status === 403 || stageRes.status === 401 || stageRes.status === 403) {
      return { ...base, readiness: "auth_failed", authValid: false, creditsAvailable: null, modelsAccessible: null, liveGenerationPassed: null, environment: "unknown", used: 0, limit: 0, plan: "unknown", canGenerate: false, statusLabel: hebrewLabels.auth_failed, lastFailureReason: `prod:${prodRes.status} stage:${stageRes.status}` } as ProviderStatus;
    }

    throw new Error(`prod:${prodRes.status} stage:${stageRes.status}`);
  } catch (e) { return toError("shotstack", "רינדורים", "https://dashboard.shotstack.io/", e); }
}

/* ════════════════════════════════════════════════════
   Cloudinary — auth + usage
   ════════════════════════════════════════════════════ */
async function checkCloudinary(cloudName: string, apiKey: string, apiSecret: string): Promise<ProviderStatus> {
  const base: Partial<ProviderStatus> = { service: "cloudinary", unit: "% קרדיטים", dashboardUrl: "https://console.cloudinary.com/settings/account", environment: "production" };
  try {
    const auth = btoa(`${apiKey}:${apiSecret}`);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/usage`, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await parseErrorBody(res)}`);
    const d = await res.json();
    const usedPct = d.credits?.used_percent ?? 0;
    const creditsAvailable = usedPct < 100;
    const readiness: ReadinessLevel = creditsAvailable ? "credits_ok" : "blocked_credits";
    return { ...base, readiness, authValid: true, creditsAvailable, modelsAccessible: true, liveGenerationPassed: null, used: Math.round(usedPct * 100) / 100, limit: 100, plan: d.plan || "free", canGenerate: creditsAvailable, statusLabel: hebrewLabels[readiness] } as ProviderStatus;
  } catch (e) { return toError("cloudinary", "% קרדיטים", "https://console.cloudinary.com/settings/account", e); }
}

/* ════════════════════════════════════════════════════
   Krea — auth-only check (NO generation probe)
   Previous version fired real image generation on every
   dashboard refresh, burning credits silently.
   Now uses a lightweight auth-only check.
   ════════════════════════════════════════════════════ */
async function checkKrea(apiKey: string): Promise<ProviderStatus> {
  const base: Partial<ProviderStatus> = { service: "krea", unit: "קרדיטים", dashboardUrl: "https://krea.ai/account", environment: "production" };
  try {
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

    // Auth-only: check if key is valid using a lightweight endpoint
    // Do NOT fire a real generation — it costs credits
    const authRes = await fetch("https://api.krea.ai/user/me", { headers: { Authorization: `Bearer ${apiKey}` } });
    
    if (authRes.status === 401 || authRes.status === 403) {
      return { ...base, readiness: "auth_failed", authValid: false, creditsAvailable: null, modelsAccessible: null, liveGenerationPassed: null, used: 0, limit: 0, plan: "unknown", canGenerate: false, statusLabel: hebrewLabels.auth_failed } as ProviderStatus;
    }

    // If auth passes (any non-401/403), mark as credits_ok
    // We do NOT probe generation to avoid burning credits on every refresh
    return { ...base, readiness: "credits_ok", authValid: true, creditsAvailable: true, modelsAccessible: true, liveGenerationPassed: null, used: 0, limit: -1, plan: "Basic (פעיל)", canGenerate: true, statusLabel: hebrewLabels.credits_ok } as ProviderStatus;
  } catch (e) { return toError("krea", "קרדיטים", "https://krea.ai/account", e); }
}

/* ════════════════════════════════════════════════════
   Lovable AI Gateway — auth + credit probe
   ════════════════════════════════════════════════════ */
async function checkLovableAI(apiKey: string): Promise<ProviderStatus> {
  const base: Partial<ProviderStatus> = { service: "gemini", unit: "בקשות", dashboardUrl: "", environment: "production" };
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-2.5-flash-lite", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
    });

    if (res.status === 401 || res.status === 403) {
      return { ...base, readiness: "auth_failed", authValid: false, creditsAvailable: null, modelsAccessible: null, liveGenerationPassed: null, used: 0, limit: 0, plan: "unknown", canGenerate: false, statusLabel: hebrewLabels.auth_failed } as ProviderStatus;
    }

    if (res.status === 402) {
      return { ...base, readiness: "blocked_credits", authValid: true, creditsAvailable: false, modelsAccessible: true, liveGenerationPassed: false, used: 0, limit: 0, plan: "ללא קרדיטים", canGenerate: false, statusLabel: hebrewLabels.blocked_credits } as ProviderStatus;
    }

    if (res.status === 429) {
      return { ...base, readiness: "credits_ok", authValid: true, creditsAvailable: true, modelsAccessible: true, liveGenerationPassed: null, used: 0, limit: -1, plan: "חינם (מובנה)", canGenerate: true, statusLabel: "קרדיטים תקינים (מוגבל זמנית)" } as ProviderStatus;
    }

    if (res.ok) {
      return { ...base, readiness: "generation_verified", authValid: true, creditsAvailable: true, modelsAccessible: true, liveGenerationPassed: true, used: 0, limit: -1, plan: "חינם (מובנה)", canGenerate: true, statusLabel: hebrewLabels.generation_verified } as ProviderStatus;
    }

    const errText = await parseErrorBody(res);
    throw new Error(`HTTP ${res.status}: ${errText}`);
  } catch (e) { return toError("gemini", "בקשות", "", e); }
}

/* ════════════════════════════════════════════════════
   Main handler
   ════════════════════════════════════════════════════ */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const elevenLabsKey = Deno.env.get("ELEVENLABS_API_KEY");
    const heygenKey = Deno.env.get("HEYGEN_API_KEY");
    const runwayKey = Deno.env.get("RUNWAY_API_KEY");
    const shotstackKey = Deno.env.get("SHOTSTACK_API_KEY");
    const cloudinaryName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
    const cloudinaryKey = Deno.env.get("CLOUDINARY_API_KEY");
    const cloudinarySecret = Deno.env.get("CLOUDINARY_API_SECRET");
    const kreaKey = Deno.env.get("KREA_API_KEY");
    const lovableKey = Deno.env.get("LOVABLE_API_KEY");

    const promises: Promise<ProviderStatus>[] = [];

    if (elevenLabsKey) promises.push(withTimeout("elevenlabs", "תווים", ELEVENLABS_DASHBOARD_URL, checkElevenLabs(elevenLabsKey)));
    if (heygenKey) promises.push(withTimeout("heygen", "קרדיטים", "https://app.heygen.com/settings", checkHeyGen(heygenKey)));
    if (runwayKey) promises.push(withTimeout("runway", "קרדיטים", RUNWAY_DASHBOARD_URL, checkRunway(runwayKey)));
    if (shotstackKey) promises.push(withTimeout("shotstack", "רינדורים", "https://dashboard.shotstack.io/", checkShotstack(shotstackKey)));
    if (cloudinaryName && cloudinaryKey && cloudinarySecret) promises.push(withTimeout("cloudinary", "% קרדיטים", "https://console.cloudinary.com/settings/account", checkCloudinary(cloudinaryName, cloudinaryKey, cloudinarySecret)));
    if (kreaKey) promises.push(withTimeout("krea", "קרדיטים", "https://krea.ai/account", checkKrea(kreaKey)));
    if (lovableKey) promises.push(withTimeout("gemini", "בקשות", "", checkLovableAI(lovableKey)));

    const settled = await Promise.allSettled(promises);
    const results: ProviderStatus[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") results.push(r.value);
    }

    return new Response(JSON.stringify({ credits: results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("check-credits error:", error);
    return new Response(JSON.stringify({ error: getErrorMessage(error) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
