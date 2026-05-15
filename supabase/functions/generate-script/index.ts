// Deno.serve used natively

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const escapeControlCharsInJsonStrings = (input: string): string => {
  let output = "";
  let inString = false;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      output += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      output += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      output += ch;
      continue;
    }

    if (inString) {
      if (ch === "\n") {
        output += "\\n";
        continue;
      }
      if (ch === "\r") {
        output += "\\r";
        continue;
      }
      if (ch === "\t") {
        output += "\\t";
        continue;
      }

      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        output += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
    }

    output += ch;
  }

  return output;
};

const stripCodeFenceMarkers = (value: string): string =>
  value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

const extractFirstJsonObject = (input: string): string | null => {
  const text = stripCodeFenceMarkers(input);
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
};

const parseModelJsonContent = (content: string) => {
  const raw = content.trim();
  const deFenced = stripCodeFenceMarkers(raw);
  const candidates: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (value?: string | null) => {
    const next = value?.trim();
    if (!next || seen.has(next)) return;
    seen.add(next);
    candidates.push(next);
  };

  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const braceMatch = deFenced.match(/\{[\s\S]*\}/);

  addCandidate(deFenced);
  addCandidate(fencedMatch?.[1]);
  addCandidate(extractFirstJsonObject(raw));
  addCandidate(braceMatch?.[0]);
  addCandidate(raw);

  let lastErr: unknown = null;

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (firstErr) {
      lastErr = firstErr;
    }

    try {
      return JSON.parse(escapeControlCharsInJsonStrings(candidate));
    } catch (secondErr) {
      lastErr = secondErr;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("Failed to parse AI JSON");
};

const splitToSentenceChunks = (input: string): string[] => {
  const sentences = input
    .split(/\n+|(?<=[.!?！？。])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length === 0) return [];

  const targetScenes = Math.min(6, Math.max(3, Math.ceil(sentences.length / 2)));
  const chunkSize = Math.max(1, Math.ceil(sentences.length / targetScenes));
  const chunks: string[] = [];

  for (let i = 0; i < sentences.length && chunks.length < 6; i += chunkSize) {
    chunks.push(sentences.slice(i, i + chunkSize).join(" "));
  }

  return chunks;
};

const buildFallbackScenes = (sourceText: string, selectedStyle?: string) => {
  const chunks = splitToSentenceChunks(sourceText);
  const baseChunks = chunks.length > 0
    ? chunks
    : [
        "פותחים בהוק ברור שמציג את הערך המרכזי.",
        "מציגים את הפתרון ואת היתרונות המרכזיים ללקוח.",
        "מסיימים עם קריאה לפעולה ברורה וממוקדת.",
      ];

  return baseChunks.slice(0, 6).map((text, idx) => ({
    id: idx + 1,
    title: `סצנה ${idx + 1}`,
    speaker: "קריין",
    spokenText: text,
    visualDescription: "סצנה קולנועית מותאמת לנושא, עם תאורה מקצועית, עומק שדה ותנועה טבעית בפריים.",
    backgroundAction: "ברקע יש תנועה דינמית של אנשים/אלמנטים סביבתיים שמוסיפה חיים ואותנטיות.",
    cameraDirection: "פתיחה ב-Wide shot ולאחריה Dolly-in עדין למוקד הסצנה",
    environment: "סביבה ריאליסטית מתאימה לעולם התוכן של הסרטון",
    characters: "דמות מרכזית ודמויות משנה רלוונטיות עם שפת גוף טבעית",
    subtitleText: text.slice(0, 64),
    icons: ["🎬", "✨"],
    duration: 10,
    transition: "fade",
    videoStyle: selectedStyle || "cinematic",
  }));
};

const buildFallbackScriptPayload = (rawContent: string, promptText: string, selectedStyle?: string) => {
  const baseText = stripCodeFenceMarkers(rawContent).trim() || promptText.trim();
  const scenes = buildFallbackScenes(baseText || promptText, selectedStyle);

  return {
    title: "תסריט וידאו",
    script: scenes.map((scene) => scene.spokenText).join(" "),
    scenes,
    duration: scenes.length * 10,
    style: { cinematicStyle: selectedStyle || "cinematic" },
  };
};

  const formatDuration = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m === 0) return `${s} שניות`;
    if (s === 0) return m === 1 ? 'דקה' : `${m} דקות`;
    return `${m}:${String(s).padStart(2, '0')} דקות`;
  };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const { prompt, avatarNames, voiceNames, brandContext, hasImages, videoStyle, websiteUrl, websiteContext, hasScreenshot, targetDurationSec, videoType } = await req.json();

    if (!prompt?.trim()) {
      return new Response(JSON.stringify({ error: "יש להזין תיאור לסרטון" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const avatarContext = avatarNames?.length
      ? `\nהאווטארים הזמינים לסרטון: ${avatarNames.join(", ")}. שלב אותם בתסריט כדוברים או דמויות.`
      : "";

    const voiceContext = voiceNames?.length
      ? `\nהקולות הזמינים לקריינות: ${voiceNames.join(", ")}. ציין בכל סצנה מי הדובר/קריין.`
      : "";

    const imageContext = hasImages
      ? `\nיש תמונות/לוגו שהמשתמש העלה — שלב אותן בסצנות. הלוגו חייב להופיע לפחות בפתיחה ובסיום.`
      : "";

    const brandInfo = brandContext
      ? `\nהמותג: ${brandContext}. חובה לשלב את שם המותג ואת המסר המרכזי שלו בתסריט.`
      : "";

    const websiteInfo = websiteContext
      ? `\n## מידע מהאתר של הלקוח (${websiteUrl || 'לא צוין URL'})
המערכת סרקה את האתר ומצאה את המידע הבא. **חובה** לשלב את התוכן, הצבעים, והמסרים מהאתר בתסריט:
${websiteContext}
${hasScreenshot ? '\nיש צילום מסך של האתר — שלב סצנה שמציגה את האתר (מסך מחשב/טלפון שמציג את הדף, גלילה באתר, אינטראקציה עם הממשק).' : ''}`
      : "";

    const styleMap: Record<string, string> = {
      cinematic: `סגנון קולנועי ריאליסטי — אנשים אמיתיים, לוקיישנים אמיתיים, תאורה דרמטית כמו בסרט הוליוודי. צלם כאילו יש צוות הפקה מלא עם מצלמות RED. הדמויות נראות כמו שחקנים אמיתיים, הסביבה ריאלית לחלוטין.`,
      disney: `סגנון אנימציה תלת-ממדית איכותית ברמת Pixar/DreamWorks — 
**חובה** לשמור על הקוים הבאים בכל סצנה:
1. **דמויות**: מפורטות ברמה גבוהה מאוד, עם עיניים גדולות מבטיות ונוצצות, שיער מפורט עם תנועה טבעית, טקסטורת עור חלקה וריאליסטית, ביגוד עם קפלים ופרטי בד. כל דמות חייבת להרגיש כמו דמות Pixar אמיתית — לא קריקטורה שטוחה אלא 3D rendering מלא.
2. **הבעות פנים**: אקספרסיביות ומוגזמות קלות כמו ב-Pixar — חיוך רחב, עיניים שנפתחות מהפתעה, גבות שעולות, פה פתוח מהתפעלות. ההבעות מספרות את הסיפור בלי מילים.
3. **תאורה**: Volumetric lighting — קרני אור נראות באוויר, Rim light דרמטי סביב הדמויות, Global Illumination חמה, צללים רכים ומפורטים. תאורה כמו בסרטי Pixar כשהאור "צובע" את הסצנה.
4. **סביבות**: מפורטות במיוחד — כל אובייקט ברקע משודרג לרמת Pixar. טקסטורות של עץ, אבן, מתכת, זכוכית — הכל נראה מוחשי. סביבות עם עומק: שכבות של Foreground/Midground/Background.
5. **צבעים**: פלטה עשירה ורוויה — גוונים חמים (כתום, צהוב, אדום) עם ניגוד של גוונים קרים (כחול כהה, סגול). Subsurface scattering על עור ועלים. צבעים שנראים "חיים" ומגנטיים.
6. **עקביות דמויות**: **קריטי** — הדמויות חייבות להיראות זהות בכל סצנה! אותו צבע עיניים, אותו סגנון שיער, אותו ביגוד (אלא אם כן יש שינוי מכוון). תאר כל דמות עם "Character Sheet" — גיל, מבנה גוף, צבע עור, צבע שיער, צבע עיניים, ביגוד ספציפי.
7. **תנועה**: כל סצנה חייבת להרגיש חיה — שיער מתנפנף, בדים זזים, אובייקטים ברקע זזים, חלקיקים באוויר (אבק, ניצוצות, עלים).`,
      anime: `סגנון אנימה יפני — קווי מתאר ברורים, עיניים גדולות ונוצצות, שיער דינמי, אפקטי תאורה דרמטיים עם ניצוצות ואור. רקעים מצוירים בפירוט רב עם שמיים צבעוניים. תנועות דינמיות ודרמטיות. סגנון שמזכיר Studio Ghibli או Makoto Shinkai.`,
      cartoon: `סגנון קריקטורה / איור — דמויות מצוירות ביד עם קווים עבים, צבעים בוהקים ושטוחים, הגזמה בתנועות ובהבעות. סביבות מעוצבות כמו איור בספר ילדים או קומיקס. הומור ויזואלי, אלמנטים מעופפים, אפקטים קומיים.`,
      documentary: `סגנון דוקומנטרי מקצועי — צילום טבעי, תאורה אמביינטית, מצלמה ביד עם רעידות קלות שנותנות תחושת אותנטיות. ראיונות עם רקע מטושטש (bokeh), טקסט על המסך עם שם ותפקיד. הכל מרגיש אמיתי ואותנטי, לא מבוים.`,
      commercial: `סגנון פרסומת טלוויזיה — הפקה מבריקה, תאורת סטודיו מושלמת, צבעים חיים ומדויקים, תנועות מצלמה חלקות ומרהיבות. מוצרים מצולמים בזוויות מושלמות עם השתקפויות ובוהק. הכל נקי, חד, ומלוטש ברמה הגבוהה ביותר.`,
    };

    const chosenStyle = styleMap[videoStyle || 'cinematic'] || styleMap.cinematic;

    const systemPrompt = `אתה במאי קולנוע ותסריטאי וידאו ברמה עולמית. אתה יוצר תסריטים קולנועיים מרהיבים — כמו סרט קצר מקצועי או פרסומת ברמת הוליווד.

## סגנון ויזואלי שנבחר
${chosenStyle}
**חובה**: כל תיאור ויזואלי, דמויות, סביבות ורקעים חייבים להיות בסגנון הזה בלבד. אל תערבב סגנונות.

## עיקרון מרכזי — התאמה מלאה לתחום הפעילות
אתה חייב לזהות את תחום הפעילות מתוך תיאור המשתמש ולהתאים את כל הבימוי, הסצנות, הרקעים, הדמויות והאווירה לתחום הזה.

**דוגמאות להתאמה לפי תחום:**
- **מוצרי ילדים/תינוקות**: הורים עם ילדים, חדרי ילדים צבעוניים, גני שעשועים, עגלות, צעצועים, תאורה חמה ורכה, חיוכים
- **עסקים/B2B**: משרדים מודרניים, אנשי עסקים בפגישות, גרפים על מסכים, לחיצות ידיים, בניינים מרשימים, תאורה מקצועית
- **מסעדנות/אוכל**: מטבח פעיל, שפים מבשלים, מנות צבעוניות, אדים עולים, טקסטורות של מזון, תאורה טבעית חמה
- **עמותות/חברתי**: אנשים מתנדבים, קהילה פעילה, חיבוקים, פעילות שטח, רגעים מרגשים
- **טכנולוגיה/סטארטאפ**: מסכים עם קוד, צוותים עובדים, משרד open-space, מוצר דיגיטלי בפעולה
- **אופנה/יופי**: דוגמניות, סטודיו צילום, תאורה דרמטית, בדים וטקסטורות, פוזות
- **נדל"ן**: דירות מעוצבות, נופים עירוניים, משפחות מאושרות בבית חדש, אדריכלות
- **בריאות/רפואה**: מרפאה נקייה, רופאים מקצועיים, מטופלים מחייכים, ציוד רפואי מודרני
- **חינוך**: כיתות לימוד, סטודנטים, ספרים, מורים, אווירת למידה
- **ספורט/כושר**: חדרי כושר, ספורטאים בפעולה, תחרויות, אנרגיה גבוהה

**אל תתקבע על תחום אחד! זהה את התחום מהתיאור של המשתמש והתאם הכל.**

## מבנה הסרטון
${(() => {
  const dur = typeof targetDurationSec === 'number' && targetDurationSec > 0 ? targetDurationSec : 60;
  const sceneCount = Math.max(3, Math.min(60, Math.round(dur / 10)));
  const minScenes = Math.max(3, sceneCount - 2);
  const maxScenes = sceneCount + 2;
  const vType = videoType || 'marketing';
  
  let structureNote = '';
  if (vType === 'podcast') {
    structureNote = `\n- זהו סרטון פודקאסט / Talking Head — רוב הסצנות הן קריינות עם B-Roll ויזואלי תומך. שמור על טון שיחתי, הסבר מעמיק, ותחושת ראיון/שיחה.`;
  } else if (vType === 'episode') {
    structureNote = `\n- זהו אפיזודה AI — סצנות מסופרות (storyboarded) עם קריינות. כל סצנה צריכה להרגיש כמו חלק מסדרה, עם קשר נרטיבי בין הסצנות.`;
  }
  
  return `- צור תסריט של **${minScenes} עד ${maxScenes} סצנות**, כל סצנה בת **10 שניות** בדיוק
- סך הכל הסרטון צריך להיות **${formatDuration(dur)}** (${dur} שניות)
- כל סצנה תיוצר כקליפ וידאו עצמאי ותחובר לסרטון אחד שלם
- התאם את מספר הסצנות לעומק התוכן — אם צריך, הוסף סצנות של הוכחות, FAQ, המלצות, דוגמאות ו-CTA נוספים כדי למלא את משך הזמן המבוקש
- **אל תעצור מוקדם!** אם התוכן קצר, מלא בתוכן נוסף: יתרונות, שימושים, המלצות, שאלות נפוצות, תוצאות, סיפור לקוח, before/after${structureNote}`;
})()}

## סוג הסרטון: ${videoType === 'podcast' ? 'פודקאסט / Talking Head' : videoType === 'episode' ? 'אפיזודה AI' : 'שיווקי קצר'}

## מבנה מומלץ:
1. **סצנת פתיחה (Hook)**: הוק מסקרן שתופס תשומת לב — שאלה, טענה מפתיעה, או סיטואציה מוכרת מהתחום
2. **סצנות תוכן (2-4 סצנות)**: הצגת המוצר/שירות/ערך — כל סצנה מתמקדת בנקודה אחת עם בימוי ייחודי
3. **סצנת סיום (CTA)**: קריאה לפעולה ברורה עם שם המותג

בהתבסס על בקשת המשתמש, צור תסריט מלא לסרטון AI קולנועי.
${avatarContext}${voiceContext}${imageContext}${brandInfo}${websiteInfo}

החזר JSON בפורמט הבא בלבד (ללא טקסט נוסף):
{
  "title": "שם הסרטון",
  "duration": <מספר כולל בשניות — כפולה של 10>,
  "script": "התסריט המלא כטקסט רציף — כל מה שהקריין אומר מתחילת הסרטון עד סופו. זה חייב להיות טקסט ארוך, שוטף ומקצועי בעברית, לא רק כותרת. כלול את כל המשפטים מכל הסצנות ברצף.",
  "scenes": [
    {
      "id": 1,
      "title": "שם הסצנה",
      "speaker": "שם הדובר/אווטאר או 'קריין'",
      "spokenText": "מה נאמר בסצנה הזו — 2-3 משפטים מלאים ומקצועיים שמתאימים ל-10 שניות של דיבור. חייב להיות טקסט אמיתי, לא תיאור כללי.",
      "visualDescription": "**בימוי מלא ומפורט של הסצנה — מינימום 8-10 שורות!**
תאר כאילו אתה כותב תסריט בימוי לצוות הפקה שלם:

1. **פריים פתיחה**: מה רואים ברגע הראשון? באיזו זווית נפתחת הסצנה? מה בפוקוס?
2. **הדמות המרכזית**: מי נמצא במרכז הפריים? מה הדמות עושה? באיזו תנוחה? מה הבעת הפנים שלה? לאן היא מסתכלת?
3. **פעולה ראשית**: מה קורה — הדמות מרימה מוצר? מצביעה על מסך? הולכת לעבר המצלמה? מחייכת ומדברת?
4. **רקע קדמי (Foreground)**: אלמנטים שעוברים לפני המצלמה — יד שמניחה כוס, עלה שנופל, אדם שחולף
5. **רקע אמצעי (Midground)**: מה קורה מסביב לדמות — אנשים אחרים, רהיטים, מוצרים על מדף, ציוד
6. **רקע אחורי (Background)**: מה רואים ברקע הרחוק — חלון עם נוף, קיר עם פוסטרים, עצים, שמיים, בניינים
7. **תאורה ואווירה**: סוג התאורה (טבעית/מלאכותית, חמה/קרה, רכה/דרמטית), צללים, השתקפויות, זוהר
8. **צבעים דומיננטיים**: פלטת הצבעים המרכזית של הסצנה — למשל: גוונים חמים של כתום וזהב, או כחולים קרירים ומקצועיים
9. **טקסטורות וחומרים**: עץ, מתכת, זכוכית, בד, עור — מה מרגישים כשמסתכלים?
10. **תנועה ודינמיות**: מה זז בסצנה? אדים עולים, וילון מתנפנף, אנשים הולכים, מסך מחליף תמונות",
      "backgroundAction": "**תיאור מלא של כל מה שקורה ברקע — מינימום 5 אלמנטים דינמיים!**
הרקע הוא מה שהופך סרטון חובבני לסרט מקצועי. תאר בדיוק:
1. **אנשים ברקע**: מי הם? מה הם עושים? לאן הם הולכים? — למשל: 'זוג צעיר עובר מימין לשמאל ומסתכל על חלון ראווה', 'ילד רץ עם בלון אדום', 'עובד מסדר מוצרים על מדף'
2. **תנועה סביבתית**: מכוניות חולפות, ציפורים עפות, עננים זזים, עלים נושרים, אורות מהבהבים
3. **אינטראקציות ברקע**: לקוח מדבר עם מוכר, ילדים משחקים, אנשים צוחקים, מישהו מצלם בטלפון
4. **אלמנטים חיים**: צמחים מתנדנדים, מים זורמים, אדים עולים מכוס קפה, שלט ניאון דולק ונכבה
5. **צלילים ויזואליים**: כלומר דברים שגורמים לך ל'שמוע' כשאתה רואה — דלת נפתחת, פעמון מצלצל, ידיים מוחאות",
      "cameraDirection": "תנועת מצלמה מקצועית ומפורטת — למשל:
- 'פתיחה ב-Wide Shot ממרחק 10 מטרים, Dolly In איטי לעבר הדמות תוך 3 שניות'
- 'Close-Up על ידיים מחזיקות מוצר, Rack Focus לפנים מחייכות'
- 'Drone Shot מלמעלה שמתקרב בספירלה לחנות'
- 'שוט מעל הכתף של הלקוח, רואים את המוכר מול'
- 'Tracking Shot עוקב אחרי הדמות ההולכת במסדרון'
- 'Slow Motion על רגע ה-Reveal של המוצר'",
      "environment": "תיאור מפורט ועשיר של הסביבה הפיזית — כולל:
- **מבנה החלל**: גודל, צורה, תקרה גבוהה/נמוכה, חלונות, דלתות, מדרגות
- **ריהוט ואביזרים**: שולחנות, כיסאות, מדפים, עציצים, תמונות על הקיר
- **תאורה מדויקת**: 'אור שמש חם נכנס מחלון צד ימין, יוצר פסים של אור על הרצפה. תאורה תקרתית רכה משלימה'
- **אווירה**: טמפרטורה, ניקיון, סדר/אי-סדר, עונה (חורף/קיץ), שעה ביום
- **פרטים ייחודיים**: לוגו על הקיר, צמח בפינה, ספלי קפה על שולחן, מחשב נייד פתוח",
      "characters": "**תיאור מלא ומפורט של כל דמות בסצנה — כאילו אתה כותב casting:**
- **דמות מרכזית**: גיל (למשל: 'אישה בת 32'), מוצא/מראה ('עור שזוף, שיער חום גלי עד הכתפיים'), ביגוד ('חולצת פשתן לבנה, מכנסי ג׳ינס כהים, נעלי סניקרס לבנות'), הבעת פנים ('חיוך חם ופתוח, עיניים נוצצות'), תנוחת גוף ('עומדת בביטחון, יד אחת על הירך'), מה עושה ('מציגה מוצר למצלמה בגאווה')
- **דמויות משניות**: תאר 2-3 דמויות נוספות באותה רמת פירוט
- **אינטראקציות בין דמויות**: מי מדבר עם מי, מבטים, חיוכים, מגע",
      "subtitleText": "כתובית בעברית (6-10 מילים) שתופיע על המסך — סיכום קצר וקולע של מה שנאמר בסצנה",
      "icons": ["🎯", "💡"],
      "duration": 10,
      "transition": "fade",
      "videoStyle": "${videoStyle || 'cinematic'}"
    }
  ],
  "style": {
    "tone": "דרמטי / קליל / מעורר השראה / מקצועי / חם ומשפחתי",
    "pace": "מהיר / בינוני / איטי",
    "music": "סגנון מוזיקה מומלץ שמתאים לתחום — למשל: מוזיקה משפחתית חמה, ביט עסקי מודרני, מוזיקה אלקטרונית אנרגטית",
    "cinematicStyle": "${videoStyle || 'cinematic'}"
  }
}

## הנחיות קריטיות ליצירת תסריט ברמת בימוי מלא:

### חזון ויזואלי — זה החלק הכי חשוב! צריך לתאר כמו במאי לצוות הפקה!
- **visualDescription חייב להיות מינימום 8-10 שורות מפורטות!** לא 3 שורות — 10 שורות של בימוי מלא!
- תאר כל שכבה בנפרד: Foreground, Midground, Background
- תאר תאורה ספציפית: מאיפה האור בא, איזה צבע, איזו עוצמה, צללים
- תאר צבעים ספציפיים: לא "צבעוני" אלא "גוונים של אפרסק וזהב עם ניגוד של כחול כהה"
- תאר טקסטורות: עץ חם, מתכת מצוחצחת, זכוכית שקופה, בד רך
- **backgroundAction חייב לכלול מינימום 5 אלמנטים דינמיים שונים!** לא 2-3, אלא 5!
- **characters חייב לתאר כל דמות כמו casting call** — גיל, מראה, ביגוד, הבעה, תנוחה, פעולה

### הסרטון חייב להרגיש חי ודינמי — לא סטטי!
- כל פריים חייב להכיל תנועה — דמויות זזות, אובייקטים זזים, מצלמה זזה
- שלב Slow Motion ברגעי שיא
- שלב Close-Up על פרטים קטנים ומעניינים (ידיים, מוצר, חיוך, עיניים)
- צור מגוון: פנים/חוץ, קרוב/רחוק, שקט/אנרגטי
- הוסף "רגעי WOW" — reveal דרמטי, זווית מפתיעה, מעבר יצירתי

### ויראליות — הסרטון חייב לגרום לאנשים לשתף!
- Hook תופס ב-3 שניות הראשונות — שאלה פרובוקטיבית, תמונה מפתיעה, סיטואציה מוכרת
- כל סצנה חייבת לתת ערך או רגש
- הסיום חייב להשאיר רושם — twist, חיוך, מסר חזק
- המוזיקה חייבת להתאים לקצב ולתחום

### טקסט וקריינות:
- spokenText חייב להיות טבעי ומקצועי — כאילו קריין אמיתי מדבר בעברית שוטפת
- כל סצנה: 2-3 משפטים מלאים שמתאימים ל-10 שניות דיבור
- script (השדה הראשי) חייב להכיל את כל הטקסט מכל הסצנות מחובר ברצף שוטף
- הקריינות חייבת להיות בעברית תקנית, שוטפת, מקצועית
- הטקסט חייב להיות רלוונטי ומדויק לתחום הפעילות — לא כללי!

### כתוביות:
- subtitleText — כתובית בעברית של 6-10 מילים שמסכמת את הנאמר
- הכתוביות יוצגו על הסרטון — חייבות להיות קריאות וברורות`;

    // Try models in order: cheapest first
    const modelsToTry = [
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "openai/gpt-4o-mini",
    ];

    let response: Response | null = null;
    let lastErrorText = "";

    for (const model of modelsToTry) {
      console.log(`Trying script model: ${model}`);
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
            { role: "user", content: prompt },
          ],
        }),
      });

      if (attempt.ok) {
        response = attempt;
        break;
      }

      lastErrorText = await attempt.text();
      console.warn(`Script model ${model} failed: ${attempt.status} ${lastErrorText.slice(0, 200)}`);

      if (attempt.status === 429) {
        return new Response(JSON.stringify({ error: "יותר מדי בקשות, נסה שוב בעוד רגע" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Continue to next model on 402/5xx
      if (attempt.status !== 402 && attempt.status < 500) break;
    }

    if (!response) {
      console.error("All script models failed. Last error:", lastErrorText.slice(0, 300));
      throw new Error("שגיאה בשירות ה-AI — כל המודלים נכשלו");
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    let parsed;
    try {
      parsed = parseModelJsonContent(content || "");

      const fallbackBaseText =
        typeof parsed?.script === "string" && parsed.script.trim()
          ? parsed.script
          : typeof content === "string"
          ? stripCodeFenceMarkers(content)
          : prompt;

      const incomingScenes = Array.isArray(parsed?.scenes) ? parsed.scenes : [];
      const normalizedScenes = incomingScenes
        .map((scene: any, idx: number) => {
          const spokenText =
            typeof scene?.spokenText === "string" && scene.spokenText.trim()
              ? scene.spokenText.trim()
              : "";
          if (!spokenText) return null;

          const title =
            typeof scene?.title === "string" && scene.title.trim()
              ? scene.title.trim()
              : `סצנה ${idx + 1}`;

          const rawVisual = typeof scene?.visualDescription === "string" ? scene.visualDescription.trim() : "";
          const rawBackground = typeof scene?.backgroundAction === "string" ? scene.backgroundAction.trim() : "";
          const rawCamera = typeof scene?.cameraDirection === "string" ? scene.cameraDirection.trim() : "";
          const rawEnvironment = typeof scene?.environment === "string" ? scene.environment.trim() : "";
          const rawCharacters = typeof scene?.characters === "string" ? scene.characters.trim() : "";

          const visualDescription = rawVisual.length >= 180
            ? rawVisual
            : `פריים פתיחה: ${title} — ${spokenText}.\nדמות מרכזית בפוקוס עם הבעה אותנטית ושפת גוף טבעית.\nForeground: אלמנט נע (יד/עלה/אובייקט) שעובר בפריים.\nMidground: אנשים/אובייקטים תומכים שמחזקים את המסר.\nBackground: סביבה עמוקה ורלוונטית לתחום הפעילות.\nתאורה קולנועית: Key light רכה + Rim light להפרדת הדמות מהרקע.\nצבעוניות: פלטה מקצועית עקבית עם ניגוד ברור לנושא.\nטקסטורות: בד/עץ/זכוכית/מתכת ברמת פירוט גבוהה.\nתנועת מצלמה: מעבר חלק שמדגיש את האקשן המרכזי.\nסיום הסצנה בפריים שמכין מעבר טבעי לסצנה הבאה.`;

          const backgroundAction = rawBackground.length >= 120
            ? rawBackground
            : `ברקע יש לפחות 5 אלמנטים דינמיים: (1) אנשים בתנועה טבעית, (2) אינטראקציה אנושית משנית, (3) אלמנט סביבתי נע (אור/עשן/עלים), (4) אובייקט עבודה/מוצר בפעולה, (5) שינוי עומק שמוסיף חיים לפריים.`;

          const cameraDirection = rawCamera.length >= 16
            ? rawCamera
            : "פתיחה ב-Wide Shot, מעבר ל-Medium עם Dolly-in עדין, וסיום ב-Close-up רגשי";

          const environment = rawEnvironment.length >= 60
            ? rawEnvironment
            : "סביבה ריאליסטית עשירה בפרטים, מותאמת לתחום הפעילות, עם תאורה מקצועית ועומק ויזואלי ברור";

          const characters = rawCharacters.length >= 60
            ? rawCharacters
            : "דמות מרכזית מפורטת (גיל, לבוש, הבעה, תנוחה) ודמויות משנה תומכות עם אינטראקציה טבעית";

          return {
            id: idx + 1,
            title,
            speaker:
              typeof scene?.speaker === "string" && scene.speaker.trim()
                ? scene.speaker.trim()
                : "קריין",
            spokenText,
            visualDescription,
            backgroundAction,
            cameraDirection,
            environment,
            characters,
            subtitleText:
              typeof scene?.subtitleText === "string" && scene.subtitleText.trim()
                ? scene.subtitleText.trim().slice(0, 64)
                : spokenText.slice(0, 64),
            icons:
              Array.isArray(scene?.icons) && scene.icons.length > 0
                ? scene.icons.slice(0, 4)
                : ["🎬", "✨"],
            duration: 10,
            transition:
              typeof scene?.transition === "string" && scene.transition.trim()
                ? scene.transition.trim()
                : "fade",
            videoStyle:
              typeof scene?.videoStyle === "string" && scene.videoStyle.trim()
                ? scene.videoStyle.trim()
                : videoStyle || "cinematic",
          };
        })
        .filter(Boolean);

      parsed.scenes = normalizedScenes.length > 0 ? normalizedScenes : buildFallbackScenes(fallbackBaseText, videoStyle);

      const targetSceneCount = typeof targetDurationSec === 'number' && targetDurationSec > 0
        ? Math.max(3, Math.round(targetDurationSec / 10))
        : 6;
      const minScenes = Math.max(3, targetSceneCount - 2);

      if (parsed.scenes.length < minScenes) {
        const fillers = buildFallbackScenes(fallbackBaseText, videoStyle);
        const existingCount = parsed.scenes.length;
        const needed = minScenes - existingCount;
        const additions = fillers.slice(0, needed).map((scene: any, idx: number) => ({
          ...scene,
          id: existingCount + idx + 1,
        }));
        parsed.scenes = [...parsed.scenes, ...additions];
      }

      const maxScenes = targetSceneCount + 2;
      if (parsed.scenes.length > maxScenes) {
        parsed.scenes = parsed.scenes.slice(0, maxScenes);
      }

      if (typeof parsed.title !== "string" || !parsed.title.trim()) {
        parsed.title = "תסריט וידאו";
      }

      const joinedScript = parsed.scenes.map((scene: any) => scene.spokenText).join(" ").trim();
      if (typeof parsed.script !== "string" || !parsed.script.trim()) {
        parsed.script = joinedScript || prompt;
      }

      parsed.duration = parsed.scenes.length * 10;
      parsed.style = typeof parsed.style === "object" && parsed.style !== null ? parsed.style : {};
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr, "Content preview:", content?.slice(0, 300));
      parsed = buildFallbackScriptPayload(typeof content === "string" ? content : "", prompt, videoStyle);
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-script error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "שגיאה ביצירת תסריט" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
