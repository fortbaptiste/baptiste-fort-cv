import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { FACTUAL_CONTEXT, SYSTEM_PROMPT } from "./persona.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const API_KEY = process.env.OPENAI_API_KEY?.trim();
const CHAT_MODEL = "gpt-5.4-mini";
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const API_BASE_URL = process.env.OPENAI_BASE_URL?.trim();
const HOST = process.env.HOST || "0.0.0.0";
const ALLOWED_ORIGINS = new Set([
  "https://fortbaptiste.github.io",
  ...String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
]);
const client = API_KEY
  ? new OpenAI({
      apiKey: API_KEY,
      ...(API_BASE_URL ? { baseURL: API_BASE_URL } : {})
    })
  : null;

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"]
]);

const limits = new Map();

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  };
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host || ALLOWED_ORIGINS.has(origin);
  } catch {
    return false;
  }
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(req)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
}

function rateLimited(req, bucket, max, windowMs = 10 * 60 * 1000) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "") || req.socket.remoteAddress || "local";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (limits.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  if (recent.length >= max) return true;
  recent.push(now);
  limits.set(key, recent);
  return false;
}

async function readJson(req, maxBytes = 256_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error("Payload trop volumineux"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("JSON invalide"), { statusCode: 400 });
  }
}

function cleanMessages(value) {
  if (!Array.isArray(value)) throw Object.assign(new Error("Historique invalide"), { statusCode: 400 });
  const messages = value.slice(-20).map((message) => {
    const role = message?.role;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    if (!["user", "assistant"].includes(role) || !content || content.length > 6_000) {
      throw Object.assign(new Error("Message invalide"), { statusCode: 400 });
    }
    return { role, content };
  });
  if (!messages.length || messages.at(-1).role !== "user") {
    throw Object.assign(new Error("Un message utilisateur est requis"), { statusCode: 400 });
  }
  return messages;
}

function initSse(res) {
  res.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Portfolio-AI-Model": CHAT_MODEL
  });
  res.flushHeaders?.();
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function handleChat(req, res) {
  if (!originAllowed(req)) return json(res, 403, { error: "Origine refusée" });
  if (rateLimited(req, "chat", 40)) return json(res, 429, { error: "Trop de messages. Réessayez dans quelques minutes." });

  const body = await readJson(req);
  const messages = cleanMessages(body.messages);
  if (!client) {
    return json(res, 503, {
      error: "Le chat OpenAI n’est pas configuré. Ajoutez une nouvelle clé côté serveur puis redémarrez l’application."
    });
  }

  initSse(res);

  try {
    const stream = await client.responses.create({
      model: CHAT_MODEL,
      instructions: `${SYSTEM_PROMPT}\n\n${FACTUAL_CONTEXT}`,
      input: messages,
      reasoning: { effort: "none" },
      max_output_tokens: 900,
      store: false,
      stream: true
    });

    for await (const event of stream) {
      if (event.type === "response.output_text.delta" && event.delta) {
        sse(res, { type: "delta", delta: event.delta });
      } else if (event.type === "response.completed") {
        sse(res, { type: "done" });
      } else if (["response.failed", "response.incomplete", "error"].includes(event.type)) {
        const reason = event.response?.error?.message || event.error?.message || "La réponse a été interrompue.";
        sse(res, { type: "error", error: reason });
      }
    }
    res.end();
  } catch (error) {
    console.error("OpenAI chat error:", error?.status || error?.name || "unknown");
    sse(res, { type: "error", error: "Je rencontre un souci de connexion. Réessayez dans un instant." });
    res.end();
  }
}

function audioExtension(mimeType) {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

async function handleTranscription(req, res) {
  if (!originAllowed(req)) return json(res, 403, { error: "Origine refusée" });
  if (rateLimited(req, "audio", 15)) return json(res, 429, { error: "Trop de notes vocales. Réessayez plus tard." });

  const body = await readJson(req, 12_000_000);
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "audio/webm";
  const encoded = typeof body.audio === "string" ? body.audio : "";
  if (!/^audio\/(webm|mp4|ogg|wav|mpeg)/.test(mimeType) || !/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    return json(res, 400, { error: "Note vocale invalide" });
  }

  const audio = Buffer.from(encoded, "base64");
  if (!audio.length || audio.length > 8_000_000) return json(res, 413, { error: "La note vocale est trop longue" });

  if (!client) return json(res, 503, { error: "La transcription sera disponible après configuration de la clé serveur." });

  try {
    const file = new File([audio], `note-vocale.${audioExtension(mimeType)}`, { type: mimeType });
    const transcription = await client.audio.transcriptions.create({
      file,
      model: TRANSCRIBE_MODEL,
      response_format: "text",
      language: "fr",
      prompt: "Conversation professionnelle au sujet du CV de Baptiste Fort, AI Engineer : n8n, RAG, agents IA, SAGS, BrokerOne, Prévoté, ABILWAYS, SOMA, Vitreflam."
    });
    const text = typeof transcription === "string" ? transcription : transcription.text;
    return json(res, 200, { text: String(text || "").trim() });
  } catch (error) {
    console.error("OpenAI transcription error:", error?.status || error?.name || "unknown");
    return json(res, 502, { error: "Je n’ai pas réussi à comprendre cette note. Vous pouvez réessayer." });
  }
}

async function serveCvDownload(req, res) {
  try {
    const content = await readFile(path.join(ROOT, "assets", "Baptiste-Fort-CV-IA.pdf"));
    res.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="Baptiste-Fort-CV-IA.pdf"',
      "Content-Length": content.length,
      "Cache-Control": "private, max-age=300"
    });
    if (req.method === "HEAD") return res.end();
    res.end(content);
  } catch {
    json(res, 404, { error: "CV introuvable" });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/portfolio-ia/") pathname = "/index.html";
  else if (pathname.startsWith("/portfolio-ia/")) pathname = pathname.slice("/portfolio-ia".length);
  if (pathname === "/") pathname = "/index.html";

  const allowed =
    pathname === "/index.html" ||
    pathname === "/styles.css" ||
    pathname === "/app.js" ||
    pathname === "/config.js" ||
    pathname.startsWith("/assets/");
  if (!allowed) return json(res, 404, { error: "Introuvable" });

  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) return json(res, 403, { error: "Chemin refusé" });

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const content = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": MIME_TYPES.get(extension) || "application/octet-stream",
      "Content-Length": content.length,
      "Cache-Control": [".html", ".css", ".js"].includes(extension) ? "no-cache" : "public, max-age=300"
    });
    if (req.method === "HEAD") return res.end();
    res.end(content);
  } catch {
    json(res, 404, { error: "Introuvable" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    applyCors(req, res);
    if (req.method === "OPTIONS" && req.url?.startsWith("/api/")) {
      if (!originAllowed(req)) return json(res, 403, { error: "Origine refusée" });
      res.writeHead(204, securityHeaders());
      return res.end();
    }
    if (["GET", "HEAD"].includes(req.method) && req.url === "/portfolio-ia") {
      res.writeHead(302, { Location: "/portfolio-ia/" });
      return res.end();
    }
    if (req.method === "GET" && req.url?.startsWith("/api/status")) {
      return json(res, 200, {
        configured: Boolean(client),
        aiEnabled: Boolean(client),
        chatModel: CHAT_MODEL,
        voice: Boolean(client)
      });
    }
    if (req.method === "POST" && req.url === "/api/chat") return await handleChat(req, res);
    if (req.method === "POST" && req.url === "/api/transcribe") return await handleTranscription(req, res);
    if (["GET", "HEAD"].includes(req.method) && req.url === "/api/cv") return await serveCvDownload(req, res);
    if (["GET", "HEAD"].includes(req.method)) return await serveStatic(req, res);
    json(res, 405, { error: "Méthode refusée" });
  } catch (error) {
    console.error("Server error:", error?.statusCode || error?.name || "unknown");
    if (!res.headersSent) json(res, error?.statusCode || 500, { error: error?.message || "Erreur serveur" });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const mode = client ? `OpenAI (${CHAT_MODEL})` : "configuration OpenAI requise";
  console.log(`Portfolio disponible sur http://${HOST}:${PORT} — mode ${mode}`);
});
