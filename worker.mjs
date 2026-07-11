import { FACTUAL_CONTEXT, SYSTEM_PROMPT } from "./persona.mjs";

const CHAT_MODEL = "gpt-5.4-mini";
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const OPENAI_API = "https://api.openai.com/v1";
const MAX_CHAT_BYTES = 256_000;
const MAX_AUDIO_BYTES = 8_000_000;
const encoder = new TextEncoder();

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function allowedOrigins(env) {
  return new Set(
    String(env.ALLOWED_ORIGINS || "https://fortbaptiste.github.io")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

function originAllowed(request, env, required = false) {
  const origin = request.headers.get("Origin");
  if (!origin) return !required;
  return allowedOrigins(env).has(origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !originAllowed(request, env)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function responseHeaders(request, env) {
  return {
    ...corsHeaders(request, env),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };
}

function json(payload, status, request, env) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...responseHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

async function readBodyLimited(request, maxBytes) {
  const announced = Number(request.headers.get("Content-Length") || 0);
  if (announced > maxBytes) throw new HttpError("Payload trop volumineux", 413);
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError("Payload trop volumineux", 413);
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readJson(request, maxBytes = MAX_CHAT_BYTES) {
  const bytes = await readBodyLimited(request, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes) || "{}");
  } catch {
    throw new HttpError("JSON invalide", 400);
  }
}

function cleanMessages(value) {
  if (!Array.isArray(value)) throw new HttpError("Historique invalide", 400);
  let totalCharacters = 0;
  const messages = value.slice(-20).map((message) => {
    const role = message?.role;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    if (!["user", "assistant"].includes(role) || !content || content.length > 6_000) {
      throw new HttpError("Message invalide", 400);
    }
    totalCharacters += content.length;
    return { role, content };
  });
  if (!messages.length || messages.at(-1).role !== "user") {
    throw new HttpError("Un message utilisateur est requis", 400);
  }
  if (totalCharacters > 30_000) throw new HttpError("Conversation trop longue. Lancez une nouvelle exploration.", 413);
  return messages;
}

async function rateAllowed(binding, key) {
  if (!binding?.limit) return true;
  const result = await binding.limit({ key });
  return Boolean(result.success);
}

async function enforceRateLimits(request, env, kind) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const bindings =
    kind === "audio"
      ? [
          [env.AUDIO_GLOBAL_LIMITER, "audio-global"],
          [env.AUDIO_CLIENT_LIMITER, `audio:${ip}`]
        ]
      : [
          [env.CHAT_GLOBAL_LIMITER, "chat-global"],
          [env.CHAT_CLIENT_LIMITER, `chat:${ip}`]
        ];
  const results = await Promise.all(bindings.map(([binding, key]) => rateAllowed(binding, key)));
  if (results.some((allowed) => !allowed)) {
    throw new HttpError("Trop de demandes. Réessayez dans une minute.", 429);
  }
}

function openAiHeaders(env) {
  if (!env.OPENAI_API_KEY) throw new HttpError("Le service IA n’est pas configuré.", 503);
  return {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    "Content-Type": "application/json"
  };
}

function emitSse(controller, payload) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

function transformOpenAiSse(stream) {
  let buffer = "";
  let terminalEventSent = false;
  const streamDecoder = new TextDecoder();

  const processPacket = (packet, controller) => {
    const data = packet
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    if (["response.output_text.delta", "response.refusal.delta"].includes(event.type) && event.delta) {
      emitSse(controller, { type: "delta", delta: event.delta });
    } else if (event.type === "response.completed") {
      terminalEventSent = true;
      emitSse(controller, { type: "done" });
    } else if (["response.failed", "response.incomplete", "error"].includes(event.type)) {
      terminalEventSent = true;
      emitSse(controller, { type: "error", error: "La réponse a été interrompue. Réessayez dans un instant." });
    }
  };

  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += streamDecoder.decode(chunk, { stream: true });
        const packets = buffer.split(/\r?\n\r?\n/);
        buffer = packets.pop() || "";
        packets.forEach((packet) => processPacket(packet, controller));
      },
      flush(controller) {
        buffer += streamDecoder.decode();
        if (buffer.trim()) processPacket(buffer, controller);
        if (!terminalEventSent) {
          emitSse(controller, { type: "error", error: "La réponse a été interrompue. Réessayez dans un instant." });
        }
      }
    })
  );
}

async function handleChat(request, env) {
  if (!originAllowed(request, env, true)) throw new HttpError("Origine refusée", 403);
  await enforceRateLimits(request, env, "chat");
  const body = await readJson(request);
  const messages = cleanMessages(body.messages);

  const upstream = await fetch(`${OPENAI_API}/responses`, {
    method: "POST",
    headers: openAiHeaders(env),
    body: JSON.stringify({
      model: CHAT_MODEL,
      instructions: `${SYSTEM_PROMPT}\n\n${FACTUAL_CONTEXT}`,
      input: messages,
      reasoning: { effort: "low" },
      max_output_tokens: 650,
      store: false,
      stream: true
    })
  });

  if (!upstream.ok || !upstream.body) {
    console.error("OpenAI chat error", upstream.status, upstream.headers.get("x-request-id") || "");
    throw new HttpError("Le service IA est momentanément indisponible.", 502);
  }

  return new Response(transformOpenAiSse(upstream.body), {
    status: 200,
    headers: {
      ...responseHeaders(request, env),
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Portfolio-AI-Model": CHAT_MODEL
    }
  });
}

function audioExtension(mimeType) {
  if (mimeType === "audio/mp4" || mimeType === "audio/x-m4a") return "m4a";
  if (mimeType === "audio/ogg") return "ogg";
  if (mimeType === "audio/wav") return "wav";
  if (mimeType === "audio/mpeg") return "mp3";
  return "webm";
}

async function handleTranscription(request, env) {
  if (!originAllowed(request, env, true)) throw new HttpError("Origine refusée", 403);
  await enforceRateLimits(request, env, "audio");

  const rawMimeType = String(request.headers.get("Content-Type") || "").toLowerCase();
  const mimeType = rawMimeType.split(";")[0].trim();
  if (!["audio/webm", "audio/mp4", "audio/x-m4a", "audio/ogg", "audio/wav", "audio/mpeg"].includes(mimeType)) {
    throw new HttpError("Format audio non pris en charge", 415);
  }

  const audio = await readBodyLimited(request, MAX_AUDIO_BYTES);
  if (!audio.byteLength) throw new HttpError("Note vocale vide", 400);
  if (!env.OPENAI_API_KEY) throw new HttpError("La transcription n’est pas configurée.", 503);

  const form = new FormData();
  form.append("file", new File([audio], `note-vocale.${audioExtension(mimeType)}`, { type: mimeType }));
  form.append("model", env.OPENAI_TRANSCRIBE_MODEL || TRANSCRIBE_MODEL);
  form.append("response_format", "json");
  form.append("language", "fr");
  form.append(
    "prompt",
    "Conversation professionnelle au sujet du CV de Baptiste Fort, AI Engineer : n8n, RAG, agents IA, SAGS, BrokerOne, Prévoté, ABILWAYS, SOMA, Vitreflam."
  );

  const upstream = await fetch(`${OPENAI_API}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form
  });

  if (!upstream.ok) {
    console.error("OpenAI transcription error", upstream.status, upstream.headers.get("x-request-id") || "");
    throw new HttpError("Je n’ai pas réussi à comprendre cette note. Vous pouvez réessayer.", 502);
  }

  const result = await upstream.json();
  const text = typeof result.text === "string" ? result.text.trim() : "";
  if (!text) throw new HttpError("La transcription est restée vide.", 502);
  return json({ text }, 200, request, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
        if (!originAllowed(request, env, true)) throw new HttpError("Origine refusée", 403);
        return new Response(null, { status: 204, headers: responseHeaders(request, env) });
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        return json(
          {
            configured: Boolean(env.OPENAI_API_KEY),
            aiEnabled: Boolean(env.OPENAI_API_KEY),
            chatModel: CHAT_MODEL,
            voice: Boolean(env.OPENAI_API_KEY),
            runtime: "cloudflare-worker"
          },
          200,
          request,
          env
        );
      }
      if (request.method === "POST" && url.pathname === "/api/chat") return await handleChat(request, env);
      if (request.method === "POST" && url.pathname === "/api/transcribe") return await handleTranscription(request, env);
      if (request.method === "GET" && url.pathname === "/") {
        return json({ service: "Baptiste Fort CV AI API", status: "ok" }, 200, request, env);
      }
      return json({ error: "Introuvable" }, 404, request, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError)) console.error("Worker error", error?.name || "unknown");
      return json({ error: error?.message || "Erreur serveur" }, status, request, env);
    }
  }
};
