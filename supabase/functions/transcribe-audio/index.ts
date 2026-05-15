// Deno.serve used natively

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type CaptionCue = {
  startSec: number;
  endSec: number;
  text: string;
};

const languageToCode = (language?: string) => {
  const value = (language || "").trim().toLowerCase();
  if (!value) return "heb";

  if (["עברית", "he", "hebrew", "heb"].includes(value)) return "heb";
  if (["english", "en", "eng"].includes(value)) return "eng";
  if (["arabic", "ar", "ara"].includes(value)) return "ara";

  return "heb";
};

const extractExtension = (mimeType: string) => {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("ogg")) return "ogg";
  return "bin";
};

const decodeBase64 = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const buildCaptionsFromWords = (words: any[]): CaptionCue[] => {
  const normalizedWords = words
    .map((w) => ({
      text: typeof w?.text === "string" ? w.text.trim() : "",
      start: Number(w?.start),
      end: Number(w?.end),
    }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start);

  const captions: CaptionCue[] = [];
  let current: CaptionCue | null = null;

  const MAX_CHARS = 84;
  const MAX_DURATION = 6.5;

  const appendToken = (base: string, token: string) => {
    const isPunctuation = /^[.,!?;:…]+$/.test(token);
    if (!base) return token;
    return isPunctuation ? `${base}${token}` : `${base} ${token}`;
  };

  for (const word of normalizedWords) {
    if (!current) {
      current = { startSec: word.start, endSec: word.end, text: word.text };
      continue;
    }

    const gap = word.start - current.endSec;
    const nextText = appendToken(current.text, word.text);
    const nextDuration = word.end - current.startSec;
    const sentenceEnded = /[.!?…]$/.test(current.text);

    const shouldSplit =
      gap > 0.55 ||
      nextText.length > MAX_CHARS ||
      nextDuration > MAX_DURATION ||
      sentenceEnded;

    if (shouldSplit) {
      captions.push(current);
      current = { startSec: word.start, endSec: word.end, text: word.text };
      continue;
    }

    current.text = nextText;
    current.endSec = Math.max(current.endSec, word.end);
  }

  if (current) captions.push(current);

  return captions
    .map((cue) => ({
      startSec: Number(cue.startSec.toFixed(3)),
      endSec: Number(cue.endSec.toFixed(3)),
      text: cue.text.trim(),
    }))
    .filter((cue) => cue.text.length > 0 && cue.endSec > cue.startSec && cue.startSec >= 0);
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
    if (!ELEVENLABS_API_KEY) {
      throw new Error("ELEVENLABS_API_KEY is not configured");
    }

    const body = await req.json();
    const sourceAudioUrl = typeof body?.sourceAudioUrl === "string" ? body.sourceAudioUrl.trim() : "";
    const audioBase64 = typeof body?.audioBase64 === "string" ? body.audioBase64 : "";
    const audioMimeType = typeof body?.audioMimeType === "string" ? body.audioMimeType : "audio/webm";
    const language = typeof body?.language === "string" ? body.language : "עברית";
    const videoDuration = Number(body?.videoDuration);

    if (!sourceAudioUrl && !audioBase64) {
      return new Response(
        JSON.stringify({ error: "חסר מקור אודיו לתמלול", provider: "elevenlabs/scribe_v2", captions: [] }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let audioBytes: Uint8Array;
    let effectiveMimeType = audioMimeType;
    let effectiveSourceUrl = sourceAudioUrl || "inline-audio";

    if (sourceAudioUrl) {
      const sourceResponse = await fetch(sourceAudioUrl);
      if (!sourceResponse.ok) {
        const bodyText = await sourceResponse.text();
        return new Response(
          JSON.stringify({
            error: `נכשלה הורדת האודיו מהמקור (סטטוס ${sourceResponse.status})`,
            provider: "source-fetch",
            status: sourceResponse.status,
            sourceAudioUrl: sourceAudioUrl,
            providerBody: bodyText.slice(0, 1000),
            captions: [],
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const arrayBuffer = await sourceResponse.arrayBuffer();
      audioBytes = new Uint8Array(arrayBuffer);
      effectiveMimeType = sourceResponse.headers.get("content-type") || effectiveMimeType;
    } else {
      audioBytes = decodeBase64(audioBase64);
    }

    const fileExtension = extractExtension(effectiveMimeType);
    const fileName = `transcribe-source.${fileExtension}`;

    const formData = new FormData();
    formData.append(
      "file",
      new File([audioBytes], fileName, {
        type: effectiveMimeType,
      })
    );
    formData.append("model_id", "scribe_v2");
    formData.append("diarize", "false");
    formData.append("tag_audio_events", "false");
    formData.append("language_code", languageToCode(language));

    const providerResponse = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: formData,
    });

    const providerStatus = providerResponse.status;
    const providerText = await providerResponse.text();

    if (!providerResponse.ok) {
      return new Response(
        JSON.stringify({
          error: `שגיאת תמלול מהספק (סטטוס ${providerStatus})`,
          provider: "elevenlabs/scribe_v2",
          status: providerStatus,
          sourceAudioUrl: effectiveSourceUrl,
          providerBody: providerText.slice(0, 1200),
          captions: [],
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let providerData: any;
    try {
      providerData = JSON.parse(providerText);
    } catch {
      return new Response(
        JSON.stringify({
          error: "ספק התמלול החזיר תגובה לא קריאה",
          provider: "elevenlabs/scribe_v2",
          status: providerStatus,
          sourceAudioUrl: effectiveSourceUrl,
          providerBody: providerText.slice(0, 1200),
          captions: [],
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const captions = buildCaptionsFromWords(Array.isArray(providerData?.words) ? providerData.words : []);

    if (!captions.length) {
      return new Response(
        JSON.stringify({
          error: "לא התקבלו כתוביות עם זמנים תקינים מהספק",
          provider: "elevenlabs/scribe_v2",
          status: providerStatus,
          sourceAudioUrl: effectiveSourceUrl,
          providerBody: providerText.slice(0, 1200),
          captions: [],
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const clampedCaptions = Number.isFinite(videoDuration) && videoDuration > 0
      ? captions
          .map((cue) => ({
            ...cue,
            endSec: Number(Math.min(cue.endSec, videoDuration).toFixed(3)),
          }))
          .filter((cue) => cue.endSec > cue.startSec)
      : captions;

    return new Response(
      JSON.stringify({
        provider: "elevenlabs/scribe_v2",
        status: providerStatus,
        sourceAudioUrl: effectiveSourceUrl,
        captions: clampedCaptions,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("transcribe error:", e);
    return new Response(
      JSON.stringify({
        error: e instanceof Error ? e.message : "שגיאה בתמלול",
        provider: "transcribe-audio",
        captions: [],
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
