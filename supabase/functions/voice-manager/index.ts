import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const PROVIDER_META_SEPARATOR = "::meta::";
const VERIFICATION_PROVIDER = "voice_verification";
const VERIFICATION_TITLE_PREFIX = "__voice_verification__";

type VerificationStatus = "approved" | "rejected" | "pending";

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const parseJsonSafe = <T>(value: string | null | undefined): T | null => {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const extractFileNameFromUrl = (audioUrl: string): string | null => {
  try {
    const parsed = new URL(audioUrl);
    const rawName = parsed.pathname.split("/").pop();
    return rawName ? decodeURIComponent(rawName) : null;
  } catch {
    return null;
  }
};

const encodeProviderWithMeta = (
  provider: string,
  meta?: Record<string, unknown>
): string => {
  if (!meta) return provider;
  return `${provider}${PROVIDER_META_SEPARATOR}${JSON.stringify(meta)}`;
};

const decodeProviderWithMeta = (
  providerValue: string
): { provider: string; meta: Record<string, unknown> | null } => {
  if (!providerValue.includes(PROVIDER_META_SEPARATOR)) {
    return { provider: providerValue, meta: null };
  }

  const [provider, rawMeta] = providerValue.split(PROVIDER_META_SEPARATOR);
  return { provider, meta: parseJsonSafe<Record<string, unknown>>(rawMeta) };
};

const parseVerificationPayload = (script: string | null): {
  status: VerificationStatus;
  providerVoiceId: string;
  selectedModel: string | null;
} | null => {
  const parsed = parseJsonSafe<{
    status?: string;
    providerVoiceId?: string;
    selectedModel?: string;
  }>(script || "");
  if (!parsed?.providerVoiceId) return null;

  const status = parsed.status;
  if (status !== "approved" && status !== "rejected" && status !== "pending") return null;

  return {
    status,
    providerVoiceId: parsed.providerVoiceId,
    selectedModel: typeof parsed.selectedModel === "string" ? parsed.selectedModel : null,
  };
};

const patchVoiceById = async (id: string, values: Record<string, unknown>) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const patchRes = await fetch(`${supabaseUrl}/rest/v1/voices?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(values),
  });

  if (!patchRes.ok) {
    const errText = await patchRes.text();
    console.error("patch voice error:", patchRes.status, errText);
    throw new Error(`שגיאה בעדכון קול: ${patchRes.status}`);
  }

  const updated = await patchRes.json();
  return updated?.[0] ?? null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = getSupabase();
    const { action, ...payload } = await req.json();

    // === VOICES CRUD ===
    if (action === "list") {
      const { data: voices, error } = await supabase
        .from("voices")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;

      const { data: verificationRows, error: verificationError } = await supabase
        .from("voice_generations")
        .select("voice_id, script, created_at, audio_url")
        .eq("provider", VERIFICATION_PROVIDER)
        .order("created_at", { ascending: false });
      if (verificationError) throw verificationError;

      const verificationMap = new Map<
        string,
        { status: VerificationStatus; created_at: string; sample_url: string; selected_model: string | null }
      >();

      for (const row of verificationRows ?? []) {
        const parsed = parseVerificationPayload(row.script);
        if (!parsed || !row.voice_id) continue;

        const key = `${row.voice_id}:${parsed.providerVoiceId}`;
        if (!verificationMap.has(key)) {
          verificationMap.set(key, {
            status: parsed.status,
            created_at: row.created_at,
            sample_url: row.audio_url,
            selected_model: parsed.selectedModel,
          });
        }
      }

      const enrichedVoices = (voices ?? []).map((voice) => {
        const key = voice.provider_voice_id
          ? `${voice.id}:${voice.provider_voice_id}`
          : null;

        const verification = key ? verificationMap.get(key) : null;
        const isVerified = Boolean(
          voice.provider_voice_id && verification?.status === "approved"
        );

        return {
          ...voice,
          is_verified: isVerified,
          verification_status: verification?.status || "unverified",
          verification_updated_at: verification?.created_at || null,
          verification_sample_url: verification?.sample_url || null,
          verification_selected_model: verification?.selected_model || null,
          training_audio_file_name: extractFileNameFromUrl(voice.audio_url),
        };
      });

      return jsonResponse({ voices: enrichedVoices });
    }

    if (action === "save") {
      const { name, audio_url, type } = payload;
      if (!name || !audio_url) {
        return jsonResponse({ error: "שם וקובץ אודיו נדרשים" }, 400);
      }

      const { data, error } = await supabase
        .from("voices")
        .insert({ name, audio_url, type: type || "recorded" })
        .select()
        .single();
      if (error) throw error;

      return jsonResponse({
        voice: {
          ...data,
          is_verified: false,
          verification_status: "unverified",
          verification_updated_at: null,
          verification_sample_url: null,
          training_audio_file_name: extractFileNameFromUrl(data.audio_url),
        },
      });
    }

    if (action === "update_provider_voice_id") {
      const { id, provider_voice_id } = payload;
      if (!id || !provider_voice_id) {
        return jsonResponse({ error: "מזהה קול ו-provider_voice_id נדרשים" }, 400);
      }

      const updated = await patchVoiceById(id, { provider_voice_id });
      return jsonResponse({
        voice: {
          ...(updated || { id, provider_voice_id }),
          is_verified: false,
          verification_status: "pending",
          verification_updated_at: null,
          verification_sample_url: null,
        },
      });
    }

    if (action === "reset_provider_voice_id") {
      const { id, delete_provider_voice } = payload as {
        id?: string;
        delete_provider_voice?: boolean;
      };

      if (!id) {
        return jsonResponse({ error: "מזהה קול נדרש" }, 400);
      }

      const { data: voice, error: voiceError } = await supabase
        .from("voices")
        .select("id, name, audio_url, provider_voice_id")
        .eq("id", id)
        .single();

      if (voiceError || !voice) {
        return jsonResponse({ error: "הקול לא נמצא" }, 404);
      }

      if (!voice.audio_url) {
        return jsonResponse({ error: "אין קובץ אימון לקול הזה. העלה/הקלט קול מחדש." }, 422);
      }

      let deletedProviderVoice = false;
      let deleteWarning: string | null = null;

      if (delete_provider_voice && voice.provider_voice_id) {
        const elevenApiKey = Deno.env.get("ELEVENLABS_API_KEY");
        if (elevenApiKey) {
          const deleteRes = await fetch(
            `https://api.elevenlabs.io/v1/voices/${voice.provider_voice_id}`,
            {
              method: "DELETE",
              headers: { "xi-api-key": elevenApiKey },
            }
          );

          if (deleteRes.ok || deleteRes.status === 404) {
            deletedProviderVoice = true;
          } else {
            const raw = await deleteRes.text();
            deleteWarning = `מחיקת קול בספק נכשלה (${deleteRes.status}): ${raw}`;
            console.warn("delete provider voice warning:", deleteWarning);
          }
        } else {
          deleteWarning = "מפתח ElevenLabs לא מוגדר למחיקת קול בספק.";
        }
      }

      const updated = await patchVoiceById(id, { provider_voice_id: null });

      return jsonResponse({
        voice: {
          ...(updated || { ...voice, provider_voice_id: null }),
          provider_voice_id: null,
          is_verified: false,
          verification_status: "unverified",
          verification_updated_at: null,
          verification_sample_url: null,
          training_audio_file_name: extractFileNameFromUrl(voice.audio_url),
        },
        deletedProviderVoice,
        deleteWarning,
      });
    }

    if (action === "delete") {
      const { id } = payload;
      if (!id) {
        return jsonResponse({ error: "מזהה קול נדרש" }, 400);
      }

      const { error } = await supabase.from("voices").delete().eq("id", id);
      if (error) throw error;
      return jsonResponse({ success: true });
    }

    // === VOICE GENERATIONS CRUD ===
    if (action === "list_generations") {
      const { data, error } = await supabase
        .from("voice_generations")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;

      const generations = (data ?? []).map((row) => {
        const decoded = decodeProviderWithMeta(row.provider || "ElevenLabs");
        const meta = decoded.meta || {};

        return {
          ...row,
          provider: decoded.provider,
          provider_voice_id_used:
            typeof meta.provider_voice_id_used === "string" ? meta.provider_voice_id_used : null,
          model_id_used:
            typeof meta.model_id_used === "string" ? meta.model_id_used : null,
          language_code_used:
            typeof meta.language_code_used === "string" ? meta.language_code_used : null,
          voice_settings_used:
            typeof meta.voice_settings_used === "object" && meta.voice_settings_used !== null
              ? meta.voice_settings_used
              : null,
          is_verification_record: decoded.provider === VERIFICATION_PROVIDER,
        };
      });

      return jsonResponse({ generations });
    }

    if (action === "save_generation") {
      const {
        title,
        script,
        voice_id,
        voice_name,
        provider,
        audio_url,
        duration_seconds,
        provider_voice_id_used,
        model_id_used,
        language_code_used,
        voice_settings_used,
      } = payload;

      if (!title || !script || !audio_url) {
        return jsonResponse({ error: "כותרת, תסריט וקובץ אודיו נדרשים" }, 400);
      }

      const providerMeta = {
        provider_voice_id_used: provider_voice_id_used || null,
        model_id_used: model_id_used || null,
        language_code_used: language_code_used || null,
        voice_settings_used:
          typeof voice_settings_used === "object" && voice_settings_used !== null
            ? voice_settings_used
            : null,
      };

      const encodedProvider = encodeProviderWithMeta(
        provider || "ElevenLabs",
        providerMeta
      );

      const { data, error } = await supabase
        .from("voice_generations")
        .insert({
          title,
          script,
          voice_id: voice_id || null,
          voice_name: voice_name || "",
          provider: encodedProvider,
          audio_url,
          duration_seconds: duration_seconds || null,
        })
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({
        generation: {
          ...data,
          provider: provider || "ElevenLabs",
          provider_voice_id_used: providerMeta.provider_voice_id_used,
          model_id_used: providerMeta.model_id_used,
          language_code_used: providerMeta.language_code_used,
          voice_settings_used: providerMeta.voice_settings_used,
          is_verification_record: false,
        },
      });
    }

    if (action === "save_voice_verification") {
      const {
        voice_id,
        provider_voice_id,
        status,
        sample_audio_url,
        selected_model,
      } = payload as {
        voice_id?: string;
        provider_voice_id?: string;
        status?: VerificationStatus;
        sample_audio_url?: string;
        selected_model?: string;
      };

      if (!voice_id || !provider_voice_id || !status || !sample_audio_url) {
        return jsonResponse({ error: "חסרים נתונים לשמירת אימות קול" }, 400);
      }

      if (!["approved", "rejected", "pending"].includes(status)) {
        return jsonResponse({ error: "סטטוס אימות לא תקין" }, 400);
      }

      const payloadScript = JSON.stringify({
        status,
        providerVoiceId: provider_voice_id,
        selectedModel: typeof selected_model === "string" ? selected_model : null,
        confirmedAt: new Date().toISOString(),
      });

      const { data, error } = await supabase
        .from("voice_generations")
        .insert({
          title: `${VERIFICATION_TITLE_PREFIX}:${status}`,
          script: payloadScript,
          voice_id,
          voice_name: "",
          provider: VERIFICATION_PROVIDER,
          audio_url: sample_audio_url,
          duration_seconds: null,
        })
        .select("id, created_at")
        .single();

      if (error) throw error;

      return jsonResponse({
        success: true,
        verification: {
          id: data.id,
          status,
          provider_voice_id,
          selected_model: typeof selected_model === "string" ? selected_model : null,
          created_at: data.created_at,
        },
      });
    }

    if (action === "delete_generation") {
      const { id } = payload;
      if (!id) {
        return jsonResponse({ error: "מזהה נדרש" }, 400);
      }

      const { error } = await supabase.from("voice_generations").delete().eq("id", id);
      if (error) throw error;
      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: "פעולה לא מוכרת" }, 400);
  } catch (e) {
    console.error("voice-manager error:", e);
    return jsonResponse({ error: e instanceof Error ? e.message : "שגיאה בניהול קולות" }, 500);
  }
});
