const statusElement = document.querySelector("#status");
const clockElement = document.querySelector("#clock");
const hintElement = document.querySelector("#hint");
const installButton = document.querySelector("#install");
const voiceLanguage = document.querySelector("#voice-language");

const voiceTexts = {
  "es-ES": {
    serie: "Para la siguiente serie de competición",
    individual: "Para el siguiente disparo de competición",
    load: "¡Carguen!",
    start: "Ya",
    stop: "Alto",
    stopAndUnload: "Alto. Descarguen",
  },
  "en-GB": {
    serie: "For the next competition series",
    individual: "For the next competition shot",
    load: "Load!",
    start: "Start",
    stop: "Stop",
    stopAndUnload: "Stop. Unload",
  },
};

const state = {
  mode: null,
  interval: null,
  phase: "idle",
  runId: 0,
  deadline: 0,
  startedAt: 0,
  nextAnnouncement: 0,
  wakeLock: null,
  wakeLockPending: false,
  installPrompt: null,
};

function setStatus(text) {
  statusElement.textContent = text;
}

function speak(text, onComplete, options = {}) {
  if (!("speechSynthesis" in window)) {
    hintElement.textContent = "Este navegador no ofrece síntesis de voz; los avisos visuales siguen activos.";
    if (onComplete) onComplete();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voiceLanguage.value;
  if (options.rate !== undefined) utterance.rate = options.rate;
  if (options.pitch !== undefined) utterance.pitch = options.pitch;
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    if (onComplete) onComplete();
  };
  utterance.onend = complete;
  utterance.onerror = (event) => {
    if (event.error !== "interrupted" && event.error !== "canceled") {
      hintElement.textContent = `No se pudo reproducir la voz (${event.error || "error desconocido"}). Comprueba las voces del dispositivo.`;
    }
    complete();
  };
  window.speechSynthesis.speak(utterance);
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator) || state.wakeLock || state.wakeLockPending
      || document.visibilityState !== "visible" || !state.mode) {
    return;
  }
  state.wakeLockPending = true;
  try {
    const lock = await navigator.wakeLock.request("screen");
    state.wakeLockPending = false;
    if (!state.mode || document.visibilityState !== "visible") {
      await lock.release();
      return;
    }
    state.wakeLock = lock;
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
      if (state.mode && document.visibilityState === "visible") {
        acquireWakeLock();
      }
    }, { once: true });
  } catch {
    state.wakeLockPending = false;
    hintElement.textContent = "No se pudo mantener la pantalla encendida; evita que el móvil se bloquee.";
  }
}

function stopTimer(message = "Entrenamiento parado") {
  window.clearInterval(state.interval);
  state.interval = null;
  state.runId += 1;
  state.mode = null;
  state.phase = "idle";
  voiceLanguage.disabled = false;
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  if (state.wakeLock) {
    const lock = state.wakeLock;
    state.wakeLock = null;
    lock.release();
  }
  setStatus(message);
}

function announceElapsed(elapsed, language = "es-ES") {
  if (state.mode === "serie") {
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    if (language === "en-GB") {
      if (minutes === 0) return `${seconds} seconds`;
      const minuteText = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
      return seconds === 0 ? minuteText : `${minuteText} and ${seconds} seconds`;
    }
    if (minutes === 0) return `${seconds} segundos`;
    if (seconds === 0) return minutes === 1 ? "Un minuto" : `${minutes} minutos`;
    return minutes === 1
      ? `Un minuto y ${seconds} segundos`
      : `${minutes} minutos y ${seconds} segundos`;
  }
  return String(elapsed);
}

function startLoadingCommand(mode, command) {
  state.phase = `${mode}-command`;
  setStatus(`Orden: «${command}, carguen»`);
  const runId = state.runId;
  speak(`${voiceTexts[voiceLanguage.value][mode]}.`, () => {
    if (state.runId !== runId || state.phase !== `${mode}-command`) return;
    state.phase = `${mode}-command-pause`;
    state.deadline = performance.now() + 300;
  });
}

function speakLoadingOrder(mode) {
  state.phase = `${mode}-loading-order`;
  const runId = state.runId;
  speak(voiceTexts[voiceLanguage.value].load, () => {
    if (state.runId !== runId || state.phase !== `${mode}-loading-order`) return;
    state.phase = `${mode}-loading`;
    state.deadline = performance.now() + 5000;
    setStatus("Carguen. ¡Ya! en 5 segundos...");
  }, { rate: 0.85, pitch: 1.2 });
}

function startIndividualLoading() {
  startLoadingCommand("individual", "Para el siguiente disparo de competición");
}

function tickIndividual(now) {
  if (state.phase === "individual-initial-delay" && now >= state.deadline) {
    startIndividualLoading();
    return;
  }

  if (state.phase === "individual-rest") {
    if (now >= state.deadline) {
      startIndividualLoading();
      return;
    }
    const secondsLeft = Math.ceil((state.deadline - now) / 1000);
    setStatus(`¡Alto! Siguiente disparo en ${secondsLeft} segundos...`);
    return;
  }

  if (state.phase === "individual-loading" && now >= state.deadline) {
    state.phase = "running";
    state.startedAt = now;
    state.nextAnnouncement = 10;
    setStatus("¡Ya! Iniciando disparo individual...");
    clockElement.textContent = "0:00";
    speak(voiceTexts[voiceLanguage.value].start);
    return;
  }

  if (state.phase !== "running") return;

  const elapsed = Math.floor((now - state.startedAt) / 1000);
  if (elapsed >= 50) {
    clockElement.textContent = "0:50";
    state.phase = "individual-rest";
    state.deadline = now + 15000;
    setStatus("¡Alto! Siguiente disparo en 15 segundos...");
    speak(voiceTexts[voiceLanguage.value].stop);
    return;
  }

  clockElement.textContent = formatTime(elapsed);
  if (elapsed >= state.nextAnnouncement) {
    speak(announceElapsed(state.nextAnnouncement));
    setStatus(`Tiempo: ${state.nextAnnouncement}s`);
    state.nextAnnouncement += 10;
  }
}

function tick() {
  const now = performance.now();

  if (state.phase === `${state.mode}-command-pause` && now >= state.deadline) {
    speakLoadingOrder(state.mode);
    return;
  }

  if (state.mode === "individual") {
    tickIndividual(now);
    return;
  }

  if (state.phase === "serie-initial-delay" && now >= state.deadline) {
    startLoadingCommand("serie", "Para la siguiente serie de competición");
    return;
  }

  if (state.phase === "serie-loading" && now >= state.deadline) {
    state.phase = "running";
    state.startedAt = now;
    state.nextAnnouncement = 20;
    setStatus("¡Ya! Iniciando serie...");
    clockElement.textContent = "0:00";
    speak(voiceTexts[voiceLanguage.value].start);
    return;
  }

  if (state.phase !== "running") return;

  const total = 250;
  const elapsed = Math.floor((now - state.startedAt) / 1000);
  if (elapsed >= total) {
    clockElement.textContent = formatTime(total);
    const stopMessage = voiceTexts[voiceLanguage.value].stopAndUnload;
    stopTimer("¡Alto! Descarguen");
    speak(stopMessage);
    return;
  }

  clockElement.textContent = formatTime(elapsed);
  if (elapsed >= state.nextAnnouncement) {
    speak(announceElapsed(state.nextAnnouncement, voiceLanguage.value));
    setStatus(`Tiempo: ${announceElapsed(state.nextAnnouncement)}`);
    state.nextAnnouncement += 20;
  }
}

function startTimer(mode) {
  stopTimer("Preparando...");
  state.mode = mode;
  voiceLanguage.disabled = true;
  clockElement.textContent = "--:--";
  if (mode === "individual") {
    state.phase = "individual-initial-delay";
    state.deadline = performance.now() + 2000;
    setStatus("Preparando el disparo...");
  } else {
    state.phase = "serie-initial-delay";
    state.deadline = performance.now() + 2000;
    setStatus("Preparando la serie...");
  }
  acquireWakeLock();
  state.interval = window.setInterval(tick, 100);
}

document.querySelector("#series").addEventListener("click", () => startTimer("serie"));
document.querySelector("#individual").addEventListener("click", () => startTimer("individual"));
document.querySelector("#stop").addEventListener("click", () => stopTimer());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") acquireWakeLock();
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPrompt = event;
  installButton.style.display = "block";
});

installButton.addEventListener("click", async () => {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  installButton.style.display = "none";
});

window.addEventListener("appinstalled", () => {
  installButton.style.display = "none";
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      hintElement.textContent = `No se pudo activar el modo sin conexión: ${error.message}`;
    });
  });
}
