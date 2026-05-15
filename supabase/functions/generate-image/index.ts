// Deno.serve used natively

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const blockedMediaHosts = /(facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com)/i;

const extractGatewayMessage = (raw: string) => {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || raw;
  } catch {
    return raw;
  }
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { prompt, action, imageUrl, referenceImages, aspectRatio } = await req.json();

    // Map aspect ratio to dimension guidance for the model
    const aspectInstruction = (() => {
      switch (aspectRatio) {
        case '16:9': return '\n\nIMPORTANT: Generate a LANDSCAPE image with 16:9 aspect ratio (wider than tall). The composition must be horizontal.';
        case '1:1': return '\n\nIMPORTANT: Generate a SQUARE image with 1:1 aspect ratio. Width and height must be equal.';
        case '9:16': return '\n\nIMPORTANT: Generate a PORTRAIT image with 9:16 aspect ratio (taller than wide). The composition must be vertical.';
        default: return '';
      }
    })();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const mediaUrls = [
      ...(action === "edit" && imageUrl ? [imageUrl] : []),
      ...(Array.isArray(referenceImages) ? referenceImages : []),
    ].filter(Boolean) as string[];

    if (mediaUrls.some((url) => blockedMediaHosts.test(url))) {
      return new Response(
        JSON.stringify({ error: "הקישור שהוזן הוא עמוד אתר (למשל YouTube) ולא קובץ תמונה ישיר. הדבק קישור ישיר ל‑JPG/PNG/WebP." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const messages: any[] = [];

    const hebrewTextGuidelines = `CRITICAL RULES FOR HEBREW TEXT IN IMAGES:
- Hebrew is written RIGHT-TO-LEFT (RTL). Never reverse the letter order.
- Each Hebrew letter must be rendered in its correct isolated/final/medial form.
- Use a clean, professional Hebrew-compatible font style (similar to Heebo, Rubik, or Noto Sans Hebrew).
- Hebrew text must be sharp, legible, and properly kerned — never blurry or distorted.
- If the prompt includes specific Hebrew words or phrases, reproduce them EXACTLY as written, character by character.
- Do NOT transliterate Hebrew into Latin characters.
- Ensure proper spacing between Hebrew words.
- For mixed Hebrew+English text, Hebrew flows RTL and English flows LTR within the same line.
- Text should have good contrast against its background for readability.`;

    if (action === "edit" && imageUrl) {
      messages.push({
        role: "system",
        content: hebrewTextGuidelines,
      });
      const contentParts: any[] = [
        { type: "text", text: (referenceImages && referenceImages.length > 0
          ? `ערוך את התמונה הראשית לפי ההוראות הבאות. השתמש בתמונות הרפרנס הנוספות כהשראה לסגנון, קומפוזיציה ואלמנטים ויזואליים — שלב אותם בתוצאה הסופית.\n\nהוראות: ${prompt}`
          : prompt) + aspectInstruction },
        { type: "image_url", image_url: { url: imageUrl } },
      ];
      // Append reference images for edit+refine
      if (Array.isArray(referenceImages)) {
        for (const refUrl of referenceImages) {
          contentParts.push({ type: "image_url", image_url: { url: refUrl } });
        }
      }
      messages.push({ role: "user", content: contentParts });
    } else if (referenceImages && referenceImages.length > 0) {
      // Generate with reference images
      messages.push({
        role: "system",
        content: hebrewTextGuidelines,
      });
      const contentParts: any[] = [
        { type: "text", text: `צור תמונה חדשה באיכות גבוהה לפי התיאור הבא. השתמש בתמונות הרפרנס המצורפות כהשראה — שלב אלמנטים מהן (אנשים, מוצרים, לוגו, סגנון) בתמונה החדשה. שים לב שכל טקסט בעברית יהיה מדויק וקריא.\n\nתיאור: ${prompt}${aspectInstruction}` },
      ];
      for (const refUrl of referenceImages) {
        contentParts.push({ type: "image_url", image_url: { url: refUrl } });
      }
      messages.push({ role: "user", content: contentParts });
    } else {
      messages.push({
        role: "system",
        content: hebrewTextGuidelines,
      });
      messages.push({
        role: "user",
        content: `צור תמונה באיכות גבוהה לפי התיאור הבא. שים לב במיוחד שכל טקסט בעברית יהיה מדויק, קריא וברור: ${prompt}${aspectInstruction}`,
      });
    }

    // Use Lovable AI Gateway (Nano Banana) as primary image generation provider
    console.log("Generating image via Lovable AI Gateway (Nano Banana)");
    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-image",
        messages,
        modalities: ["image", "text"],
      }),
    });

    if (!aiRes.ok) {
      const errRaw = await aiRes.text();
      console.error("Lovable AI image generation failed:", aiRes.status, errRaw.slice(0, 500));
      const friendly = aiRes.status === 429
        ? "חרגנו ממגבלת הקצב של שירות התמונות, נסה שוב בעוד רגע"
        : aiRes.status === 402
          ? "נגמרו הקרדיטים בשירות יצירת התמונות (Lovable AI)"
          : `שגיאה בשירות יצירת התמונות: ${extractGatewayMessage(errRaw)}`;
      return new Response(JSON.stringify({ error: friendly }), {
        status: aiRes.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiData = await aiRes.json();
    const imageData = aiData?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    const text = aiData?.choices?.[0]?.message?.content || "";

    if (!imageData) {
      return new Response(JSON.stringify({ error: "לא הצלחתי ליצור תמונה, נסה תיאור אחר", text }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ imageUrl: imageData, text }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-image error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "שגיאה לא ידועה" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
