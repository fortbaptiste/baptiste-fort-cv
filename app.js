const rail = document.querySelector("#rail");
const railToggle = document.querySelector("#railToggle");
const railBackdrop = document.querySelector("#railBackdrop");
const mainStage = document.querySelector("#mainStage");
const hero = document.querySelector("#hero");
const conversation = document.querySelector("#conversation");
const messageList = document.querySelector("#messageList");
const conversationEnd = document.querySelector("#conversationEnd");
const promptForm = document.querySelector("#promptForm");
const promptInput = document.querySelector("#promptInput");
const composer = document.querySelector(".composer");
const plusButton = document.querySelector("#plusButton");
const plusMenu = document.querySelector("#plusMenu");
const modelButton = document.querySelector("#modelButton");
const modelMenu = document.querySelector("#modelMenu");
const themeToggle = document.querySelector("#themeToggle");
const sendButton = document.querySelector("#sendButton");
const audioButton = document.querySelector("#audioButton");
const recordingPanel = document.querySelector("#recordingPanel");
const recordingWave = document.querySelector("#recordingWave");
const recordingTimer = document.querySelector("#recordingTimer");
const recordingCancel = document.querySelector("#recordingCancel");
const recordingConfirm = document.querySelector("#recordingConfirm");
const toast = document.querySelector("#toast");
const publicConfig = window.PORTFOLIO_CONFIG || {};
const API_BASE_URL = String(publicConfig.apiBaseUrl || "").replace(/\/$/, "");
const apiUrl = (pathname) => `${API_BASE_URL}${pathname}`;
const downloadLink = document.querySelector(".download-link");

if (downloadLink) {
  if (API_BASE_URL) downloadLink.href = apiUrl("/api/cv");
  else if (window.location.hostname.endsWith(".github.io")) downloadLink.href = "assets/Baptiste-Fort-CV-IA.pdf";
}

const prompts = {
  cv: "Présentez-moi votre CV en 30 secondes.",
  experiences: "Quelles expériences montrent le mieux ce que vous savez construire ?",
  why: "Pourquoi devrions-nous travailler avec vous ?",
  agents: "Quels agents IA avez-vous réellement conçus ?",
  about: "Parlez-moi de vous, au-delà de votre stack.",
  contact: "Comment puis-je vous contacter ?"
};

const messages = [];
let toastTimer;
let requestController;
let isGenerating = false;
let isTypingPreset = false;
let mediaRecorder;
let mediaStream;
let audioContext;
let analyser;
let animationFrame;
let recordingInterval;
let recordingStartedAt = 0;
let recordedChunks = [];
let recordingMimeType = "audio/webm";

function closeMenus(except = null, restoreFocus = false) {
  const plusWasOpen = !plusMenu.hidden;
  const modelWasOpen = !modelMenu.hidden;
  if (except !== plusMenu) {
    plusMenu.hidden = true;
    plusButton.setAttribute("aria-expanded", "false");
  }
  if (except !== modelMenu) {
    modelMenu.hidden = true;
    modelButton.setAttribute("aria-expanded", "false");
  }
  if (restoreFocus) {
    if (plusWasOpen) plusButton.focus();
    else if (modelWasOpen) modelButton.focus();
  }
}

function toggleMenu(menu, button) {
  const willOpen = menu.hidden;
  closeMenus(menu);
  menu.hidden = !willOpen;
  button.setAttribute("aria-expanded", String(willOpen));
  if (willOpen) {
    const firstFocusable = menu.querySelector("a, button, [tabindex]:not([tabindex='-1'])");
    if (firstFocusable) window.setTimeout(() => firstFocusable.focus(), 0);
  }
}

function setRail(open) {
  const modal = open && window.matchMedia("(max-width: 820px)").matches;
  rail.classList.toggle("is-open", open);
  railBackdrop.hidden = !modal;
  mainStage.inert = modal;
  railToggle.setAttribute("aria-expanded", String(open));
  railToggle.setAttribute("aria-label", open ? "Fermer la barre latérale" : "Ouvrir la barre latérale");
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function promptText() {
  return promptInput.textContent.replace(/\s+/g, " ").trim();
}

function setPrompt(value = "") {
  promptInput.textContent = value;
  composer.classList.toggle("has-text", Boolean(value.trim()));
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function markdown(value) {
  const lines = value.replace(/\r/g, "").split("\n");
  const output = [];
  let paragraph = [];
  let list = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    output.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
    list = [];
  };

  for (const line of lines) {
    const bullet = line.match(/^\s*[-•]\s+(.+)/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return output.join("");
}

function appendMessage(role, text = "") {
  const article = document.createElement("article");
  article.className = `message message-${role}`;

  if (role === "user") {
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = text;
    article.append(bubble);
  } else {
    const spark = document.createElement("div");
    spark.className = "answer-spark";
    spark.setAttribute("aria-hidden", "true");
    spark.textContent = "✦";
    const content = document.createElement("div");
    content.className = "message-content answer-content";
    content.textContent = text;
    article.append(spark, content);
  }

  messageList.append(article);
  return article;
}

function isNearConversationBottom() {
  return conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100;
}

function scrollConversation(force = false, behavior = "smooth") {
  if (!force && !isNearConversationBottom()) return;
  conversationEnd.scrollIntoView({ behavior, block: "end" });
}

function enterConversation() {
  if (document.body.classList.contains("has-conversation")) return;
  document.body.classList.add("has-conversation");
  hero.classList.add("has-answer");
  hero.dataset.chatState = "active";
  conversation.hidden = false;
}

function setGenerating(active) {
  isGenerating = active;
  composer.classList.toggle("is-generating", active);
  sendButton.disabled = active;
  audioButton.disabled = active;
  promptInput.setAttribute("aria-busy", String(active));
}

async function readSse(response, onEvent) {
  if (!response.ok) {
    let message = "Le service IA est momentanément indisponible.";
    try {
      const payload = await response.json();
      if (payload.error) message = payload.error;
    } catch {}
    throw new Error(message);
  }
  if (!response.body) throw new Error("Le flux de réponse est indisponible.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const packets = buffer.split("\n\n");
    buffer = packets.pop() || "";
    for (const packet of packets) {
      const data = packet
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (!data) continue;
      onEvent(JSON.parse(data));
    }
  }
}

async function sendMessage(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || isGenerating || composer.dataset.mode === "recording") return;

  closeMenus();
  enterConversation();
  appendMessage("user", clean);
  messages.push({ role: "user", content: clean });
  setPrompt("");
  scrollConversation(true, "auto");

  const assistant = appendMessage("assistant");
  const content = assistant.querySelector(".message-content");
  assistant.classList.add("is-loading");
  content.textContent = "Je regarde ce qui est le plus pertinent";
  scrollConversation(true, "smooth");
  setGenerating(true);
  requestController = new AbortController();

  let answer = "";
  try {
    const response = await fetch(apiUrl("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
      signal: requestController.signal
    });

    await readSse(response, (event) => {
      if (event.type === "delta") {
        const shouldFollow = isNearConversationBottom();
        if (!answer) {
          assistant.classList.remove("is-loading");
          content.textContent = "";
        }
        answer += event.delta || "";
        content.textContent = answer;
        if (shouldFollow) scrollConversation(true, "auto");
      } else if (event.type === "error") {
        throw new Error(event.error || "La réponse a été interrompue.");
      }
    });

    if (!answer.trim()) throw new Error("La réponse est restée vide. Réessayez dans un instant.");
    content.innerHTML = markdown(answer);
    messages.push({ role: "assistant", content: answer.trim() });
  } catch (error) {
    if (error.name === "AbortError") {
      assistant.remove();
    } else {
      assistant.classList.remove("is-loading");
      answer = error.message || "Je rencontre un souci de connexion. Réessayez dans un instant.";
      content.textContent = answer;
      assistant.classList.add("has-error");
    }
  } finally {
    setGenerating(false);
    requestController = null;
    scrollConversation(true, "smooth");
    window.setTimeout(() => promptInput.focus({ preventScroll: true }), 80);
  }
}

async function submitPrompt() {
  const value = promptText();
  if (!value) {
    promptInput.focus();
    showToast("Posez une question comme vous la poseriez en entretien.");
    return;
  }
  await sendMessage(value);
}

async function typeAndSendPreset(value) {
  if (isGenerating || isTypingPreset) return;
  isTypingPreset = true;
  setPrompt("");
  promptInput.focus({ preventScroll: true });
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    setPrompt(value);
  } else {
    for (let index = 0; index < value.length; index += 1) {
      setPrompt(value.slice(0, index + 1));
      await new Promise((resolve) => setTimeout(resolve, 7));
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 110));
  isTypingPreset = false;
  await sendMessage(value);
}

function chooseRecordingMimeType() {
  const options = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
  return options.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
}

function buildRecordingWave() {
  if (recordingWave.children.length) return;
  for (let index = 0; index < 56; index += 1) recordingWave.append(document.createElement("i"));
}

function drawRecordingWave() {
  if (!analyser) return;
  const samples = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(samples);
  const dots = [...recordingWave.children];
  dots.forEach((dot, index) => {
    const sampleIndex = Math.floor((index / dots.length) * samples.length * 0.7);
    const energy = samples[sampleIndex] / 255;
    dot.style.transform = `translateY(${((index % 2 ? 1 : -1) * energy * 4).toFixed(1)}px) scale(${(0.82 + energy * 1.25).toFixed(2)})`;
    dot.style.opacity = String(0.5 + energy * 0.5);
  });
  animationFrame = requestAnimationFrame(drawRecordingWave);
}

function updateRecordingTimer() {
  const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  recordingTimer.textContent = `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  if (seconds >= 90) finishRecording(true);
}

function stopMediaResources() {
  window.clearInterval(recordingInterval);
  cancelAnimationFrame(animationFrame);
  mediaStream?.getTracks().forEach((track) => track.stop());
  audioContext?.close().catch(() => {});
  mediaStream = null;
  audioContext = null;
  analyser = null;
}

function resetRecordingUi() {
  stopMediaResources();
  composer.dataset.mode = "idle";
  recordingPanel.hidden = true;
  recordingPanel.classList.remove("is-processing");
  recordingCancel.disabled = false;
  recordingConfirm.disabled = false;
  recordingTimer.textContent = "0:00";
  [...recordingWave.children].forEach((dot) => {
    dot.style.removeProperty("transform");
    dot.style.removeProperty("opacity");
  });
}

async function startRecording() {
  if (isGenerating || composer.dataset.mode === "recording") return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showToast("L’enregistrement vocal n’est pas disponible dans ce navigateur.");
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    recordingMimeType = chooseRecordingMimeType() || "audio/webm";
    const options = recordingMimeType ? { mimeType: recordingMimeType } : undefined;
    mediaRecorder = new MediaRecorder(mediaStream, options);
    recordedChunks = [];
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) recordedChunks.push(event.data);
    });

    buildRecordingWave();
    composer.dataset.mode = "recording";
    recordingPanel.hidden = false;
    recordingStartedAt = Date.now();
    updateRecordingTimer();
    recordingInterval = window.setInterval(updateRecordingTimer, 500);

    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 128;
    source.connect(analyser);
    drawRecordingWave();
    mediaRecorder.start(250);
  } catch (error) {
    resetRecordingUi();
    showToast(error.name === "NotAllowedError" ? "Autorisez le microphone pour envoyer une note vocale." : "Impossible de démarrer l’enregistrement.");
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function finishRecording(shouldSend) {
  if (!mediaRecorder || composer.dataset.mode !== "recording") return;

  const recorder = mediaRecorder;
  const blobPromise = new Promise((resolve) => {
    recorder.addEventListener(
      "stop",
      () => resolve(new Blob(recordedChunks, { type: recorder.mimeType || recordingMimeType })),
      { once: true }
    );
  });
  if (recorder.state !== "inactive") recorder.stop();
  stopMediaResources();

  if (!shouldSend) {
    resetRecordingUi();
    promptInput.focus({ preventScroll: true });
    return;
  }

  recordingPanel.classList.add("is-processing");
  recordingCancel.disabled = true;
  recordingConfirm.disabled = true;
  try {
    const blob = await blobPromise;
    if (!blob.size) throw new Error("La note vocale est vide.");
    const audio = await blobToBase64(blob);
    const response = await fetch(apiUrl("/api/transcribe"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio, mimeType: blob.type || recordingMimeType })
    });
    const payload = await response.json();
    if (!response.ok || !payload.text) throw new Error(payload.error || "La transcription a échoué.");
    resetRecordingUi();
    setPrompt(payload.text.trim());
    await sendMessage(payload.text);
  } catch (error) {
    resetRecordingUi();
    showToast(error.message || "Je n’ai pas réussi à comprendre cette note.");
    promptInput.focus({ preventScroll: true });
  }
}

function resetPortfolio() {
  requestController?.abort();
  if (composer.dataset.mode === "recording") finishRecording(false);
  messages.length = 0;
  messageList.replaceChildren();
  document.body.classList.remove("has-conversation");
  hero.classList.remove("has-answer");
  hero.dataset.chatState = "empty";
  conversation.hidden = true;
  setPrompt("");
  closeMenus();
  window.scrollTo({ top: 0, behavior: "smooth" });
  window.setTimeout(() => promptInput.focus({ preventScroll: true }), 180);
}

railToggle.addEventListener("click", () => setRail(!rail.classList.contains("is-open")));
railBackdrop.addEventListener("click", () => {
  setRail(false);
  railToggle.focus();
});

promptInput.addEventListener("input", () => composer.classList.toggle("has-text", Boolean(promptText())));
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitPrompt();
  }
});
promptForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitPrompt();
});

plusButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMenu(plusMenu, plusButton);
});
modelButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMenu(modelMenu, modelButton);
});

audioButton.addEventListener("click", startRecording);
recordingCancel.addEventListener("click", () => finishRecording(false));
recordingConfirm.addEventListener("click", () => finishRecording(true));

themeToggle.addEventListener("click", () => {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  localStorage.setItem("portfolio-theme", next);
  showToast(next === "dark" ? "Mode soirée activé." : "Retour à la lumière.");
});

document.addEventListener("click", (event) => {
  const actionTarget = event.target.closest("[data-action]");
  const toastTarget = event.target.closest("[data-toast]");

  if (!event.target.closest(".floating-menu") && !event.target.closest("#plusButton") && !event.target.closest("#modelButton")) closeMenus();
  if (toastTarget) showToast(toastTarget.dataset.toast);
  if (!actionTarget) return;

  const action = actionTarget.dataset.action;
  if (action === "reset") {
    resetPortfolio();
    setRail(false);
  } else if (prompts[action]) {
    typeAndSendPreset(prompts[action]);
    setRail(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (composer.dataset.mode === "recording") {
    finishRecording(false);
    return;
  }
  if (!plusMenu.hidden || !modelMenu.hidden) {
    closeMenus(null, true);
    return;
  }
  if (rail.classList.contains("is-open")) {
    setRail(false);
    railToggle.focus();
  }
});

window.addEventListener("resize", () => {
  if (!window.matchMedia("(max-width: 820px)").matches) {
    railBackdrop.hidden = true;
    mainStage.inert = false;
  } else if (rail.classList.contains("is-open")) {
    railBackdrop.hidden = false;
    mainStage.inert = true;
  }
});

const savedTheme = localStorage.getItem("portfolio-theme");
if (savedTheme === "dark" || savedTheme === "light") document.documentElement.dataset.theme = savedTheme;

hero.dataset.chatState = "empty";
composer.dataset.mode = "idle";
window.addEventListener("load", () => window.setTimeout(() => promptInput.focus({ preventScroll: true }), 220));
