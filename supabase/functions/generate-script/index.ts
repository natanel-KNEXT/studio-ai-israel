// Deno.serve used natively

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function claudeAPI(system: string, user: string, maxTokens = 6000): Promise<string> {
  const KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!KEY) throw new Error("LOVABLE_API_KEY לא מוגדר");
  const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-pro",
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`AI gateway error ${r.status}: ${t.slice(0, 200)}`); }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "";
}

function extractJSON(text: string): any {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try { return JSON.parse(clean); } catch {}
  const start = clean.indexOf("{");
  if (start !== -1) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < clean.length; i++) {
      const ch = clean[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(clean.slice(start, i + 1)); } catch {} } }
    }
  }
  throw new Error("לא הצלחתי לפרסר JSON");
}

const buildFallbackScenes = (sourceText: string, selectedStyle?: string) => {
  const chunks = sourceText.split(/[.!?]/).filter(s => s.trim().length > 5).slice(0, 6);
  const base = chunks.length >= 2 ? chunks : [sourceText];
  return base.map((text, idx) => ({
    id: idx + 1, title: `סצנה ${idx + 1}`, speaker: "קריין",
    spokenText: text.trim(),
    visualDescription: "סצנה קולנועית מקצועית עם תאורה דרמטית ועומק שדה.",
    backgroundAction: "תנועה דינמית טבעית של אנשים ואלמנטים סביבתיים.",
    cameraDirection: "Wide Shot → Dolly In → Close-Up",
    environment: "סביבה מקצועית מותאמת לתחום",
    characters: "דמות מרכזית עם הבעה אותנטית",
    subtitleText: text.trim().slice(0, 64),
    icons: ["🎬", "✨"], duration: 10, transition: "fade",
    videoStyle: selectedStyle || "cinematic",
  }));
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { prompt, avatarNames, voiceNames, brandContext, hasImages, videoStyle, websiteUrl, websiteContext, hasScreenshot, targetDurationSec, videoType } = await req.json();
    if (!prompt?.trim()) return new Response(JSON.stringify({ error: "יש להזין תיאור לסרטון" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const dur = (typeof targetDurationSec === "number" && targetDurationSec > 0) ? targetDurationSec : 60;
    const sceneCount = Math.max(3, Math.min(60, Math.round(dur / 10)));
    const minScenes = Math.max(3, sceneCount - 2);
    const maxScenes = sceneCount + 2;
    const fmtDur = (s: number) => { const m = Math.floor(s/60), r = s%60; if (!m) return `${r} שניות`; if (!r) return `${m} דקות`; return `${m}:${String(r).padStart(2,"0")} דקות`; };

    const styleMap: Record<string, string> = {
      cinematic: "סגנון קולנועי ריאליסטי — אנשים אמיתיים, לוקיישנים אמיתיים, תאורה דרמטית כמו בסרט הוליוודי.",
      disney: "סגנון אנימציה תלת-ממדית איכותית ברמת Pixar/DreamWorks — דמויות מפורטות, עיניים גדולות, תאורה Volumetric.",
      anime: "סגנון אנימה יפני — קווי מתאר ברורים, עיניים גדולות, שיער דינמי, ניצוצות ואור. Studio Ghibli.",
      cartoon: "סגנון קריקטורה — דמויות מצוירות ביד, קווים עבים, צבעים שטוחים בוהקים, הגזמה בתנועות.",
      documentary: "סגנון דוקומנטרי — צילום טבעי, תאורה אמביינטית, מצלמה ביד, ראיונות עם bokeh.",
      commercial: "סגנון פרסומת טלוויזיה — הפקה מבריקה, תאורת סטודיו מושלמת, צבעים חיים, תנועות מצלמה חלקות.",
    };
    const chosenStyle = styleMap[videoStyle || "cinematic"] || styleMap.cinematic;
    const avatarCtx = avatarNames?.length ? `\nאווטארים זמינים: ${avatarNames.join(", ")}` : "";
    const voiceCtx = voiceNames?.length ? `\nקולות זמינים: ${voiceNames.join(", ")}` : "";
    const imgCtx = hasImages ? `\nיש תמונות/לוגו — שלב אותם. הלוגו בפתיחה ובסיום.` : "";
    const brandCtx = brandContext ? `\nמותג: ${brandContext}` : "";
    const webCtx = websiteContext ? `\nמידע מהאתר (${websiteUrl || ""}):\n${websiteContext}${hasScreenshot ? "\nיש צילום מסך — שלב סצנה שמציגה את האתר." : ""}` : "";
    const typeNote = videoType === "podcast" ? "פודקאסט/Talking Head — טון שיחתי." : videoType === "episode" ? "אפיזודה AI — קשר נרטיבי." : "";

    const systemPrompt = `אתה במאי קולנוע ותסריטאי וידאו ברמה עולמית.

## סגנון ויזואלי
${chosenStyle}

## מבנה הסרטון
- ${minScenes}–${maxScenes} סצנות, כל סצנה 10 שניות
- סך הכל: ${fmtDur(dur)} (${dur} שניות)
- ${typeNote || "מבנה: Hook → תוכן → CTA"}
${avatarCtx}${voiceCtx}${imgCtx}${brandCtx}${webCtx}

החזר JSON בלבד (ללא markdown):
{
  "title": "שם הסרטון",
  "duration": <שניות>,
  "script": "הטקסט המלא הרציף",
  "scenes": [{
    "id": 1, "title": "שם הסצנה", "speaker": "קריין",
    "spokenText": "2-3 משפטים ל-10 שניות",
    "visualDescription": "בימוי מפורט: פריים, דמות, פעולה, תאורה, צבעים, תנועת מצלמה",
    "backgroundAction": "5 אלמנטים דינמיים ברקע",
    "cameraDirection": "Wide Shot → Dolly In / Close-Up",
    "environment": "תיאור הסביבה",
    "characters": "גיל, מראה, ביגוד, הבעה",
    "subtitleText": "כתובית 6-10 מילים",
    "icons": ["🎬","✨"], "duration": 10, "transition": "fade",
    "videoStyle": "${videoStyle || "cinematic"}"
  }],
  "style": { "tone": "...", "pace": "...", "music": "...", "cinematicStyle": "${videoStyle || "cinematic"}" }
}`;

    const tokenBudget = Math.min(8000, Math.max(3000, maxScenes * 600));
    const raw = await claudeAPI(systemPrompt, prompt, tokenBudget);

    let parsed: any;
    try { parsed = extractJSON(raw); }
    catch { parsed = { title: "תסריט וידאו", duration: 60, script: prompt, scenes: buildFallbackScenes(prompt, videoStyle), style: { cinematicStyle: videoStyle || "cinematic" } }; }

    if (Array.isArray(parsed.scenes)) {
      parsed.scenes = parsed.scenes.filter((s: any) => s?.spokenText?.trim()).map((s: any, i: number) => ({
        id: i+1, title: s.title || `סצנה ${i+1}`, speaker: s.speaker || "קריין",
        spokenText: s.spokenText.trim(),
        visualDescription: s.visualDescription?.length >= 80 ? s.visualDescription : `${s.spokenText.slice(0,60)} — תאורה קולנועית מקצועית.`,
        backgroundAction: s.backgroundAction || "תנועה דינמית טבעית.",
        cameraDirection: s.cameraDirection || "Wide Shot → Dolly In → Close-Up",
        environment: s.environment || "סביבה מקצועית",
        characters: s.characters || "דמות מרכזית אותנטית",
        subtitleText: (s.subtitleText || s.spokenText).slice(0, 64),
        icons: Array.isArray(s.icons) && s.icons.length ? s.icons : ["🎬","✨"],
        duration: 10, transition: s.transition || "fade", videoStyle: videoStyle || "cinematic"
      }));
    }

    if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
      parsed.scenes = buildFallbackScenes(prompt, videoStyle);
    }
    parsed.duration = parsed.scenes.length * 10;
    if (!parsed.script?.trim()) parsed.script = parsed.scenes.map((s: any) => s.spokenText).join(" ");
    if (!parsed.title?.trim()) parsed.title = "תסריט וידאו";

    return new Response(JSON.stringify(parsed), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("generate-script error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "שגיאה ביצירת תסריט" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
