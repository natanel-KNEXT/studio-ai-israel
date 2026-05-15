// Deno.serve used natively

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { text, type } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    let systemPrompt = "";

    if (type === "enhance") {
      systemPrompt = `אתה מומחה שיווק ותוכן וידאו בעברית. תפקידך לקחת רעיון גולמי ולהפוך אותו לבריף מקצועי ומסודר ליצירת סרטון.

עליך להחזיר JSON בפורמט הבא בלבד (ללא טקסט נוסף):
{
  "enhanced": "הבריף המשופר עם מבנה של הוק, גוף, הוכחה חברתית וקריאה לפעולה",
  "variations": [
    {"type": "גרסת מכירה", "text": "..."},
    {"type": "גרסת UGC", "text": "..."},
    {"type": "גרסת תוכן אישי", "text": "..."}
  ]
}

הנחיות חשובות:
- כתוב בעברית מקצועית, טבעית ושוטפת — כמו קופירייטר ישראלי מנוסה
- הימנע מתרגום מאנגלית — כתוב כאילו עברית היא שפת האם שלך
- השתמש בביטויים ישראליים אותנטיים, לא מליצות ותרגומים ישירים
- כל וריאציה צריכה להיות שונה בסגנון ובטון
- גרסת מכירה: ישירה, עם CTA חזק, דחיפות — בשפה שמוכרת בישראל
- גרסת UGC: אותנטית, בגוף ראשון, כאילו מישהו מספר לחבר בוואטסאפ
- גרסת תוכן אישי: אישית, מעוררת השראה, סיפור אישי אמיתי
- הבריף המשופר צריך לכלול: הוק (פתיח תופס), גוף (בעיה + פתרון), הוכחה חברתית, וקריאה לפעולה
- אם יש שמות מוצרים או מותגים באנגלית — השאר אותם באנגלית
- הקפד על פיסוק נכון, ניקוד תקין (אם רלוונטי), וסדר מילים טבעי בעברית`;
    } else if (type === "script") {
      systemPrompt = `אתה כותב תסריטים מקצועי לסרטוני וידאו בעברית. תפקידך ליצור תסריט מוכן לצילום/הקלטה.

עליך להחזיר JSON בפורמט הבא בלבד (ללא טקסט נוסף):
{
  "script": "התסריט המלא שהאווטאר יגיד",
  "scenes": [
    {"title": "שם הסצנה", "spokenText": "מה נאמר", "visualDescription": "מה רואים", "duration": 5}
  ]
}

הנחיות חשובות:
- כתוב בעברית ישראלית טבעית — כמו שאדם אמיתי מדבר, לא כמו תרגום
- השתמש במשפטים קצרים וברורים, מתאימים לדיבור מול מצלמה
- הימנע ממילים גבוהות או ספרותיות — כתוב בגובה העיניים
- כל סצנה עם טקסט מדובר ותיאור חזותי מפורט
- פתיח חד שתופס תשומת לב ב-3 שניות הראשונות
- סיום עם קריאה לפעולה ברורה ופשוטה
- שמור על קצב — משפטים קצרים, הפסקות טבעיות
- אם יש מונחים מקצועיים — הסבר אותם בפשטות`;
    }

    const modelsToTry = [
      "google/gemini-2.5-flash-lite",
      "google/gemini-2.5-flash",
      "openai/gpt-5-nano",
    ];

    let response: Response | null = null;
    let lastErrorText = "";

    for (const model of modelsToTry) {
      console.log(`Trying enhance model: ${model}`);
      const attempt = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ],
        }),
      });

      if (attempt.ok) {
        response = attempt;
        break;
      }

      lastErrorText = await attempt.text();
      console.warn(`Enhance model ${model} failed: ${attempt.status} ${lastErrorText.slice(0, 200)}`);

      if (attempt.status === 429) {
        return new Response(JSON.stringify({ error: "יותר מדי בקשות, נסה שוב בעוד רגע" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (attempt.status !== 402 && attempt.status < 500) break;
    }

    if (!response) {
      console.error("All enhance models failed:", lastErrorText.slice(0, 300));
      return new Response(JSON.stringify({ error: "שגיאה בשירות ה-AI — כל המודלים נכשלו" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    // Try to parse JSON from the response
    let parsed;
    try {
      // Extract JSON from potential markdown code blocks
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      parsed = { enhanced: content, variations: [] };
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("enhance-prompt error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "שגיאה לא ידועה" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
