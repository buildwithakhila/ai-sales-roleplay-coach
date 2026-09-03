const speakBtn = document.getElementById("speakBtn");
const statusEl = document.getElementById("status");
const player = document.getElementById("player");
const textEl = document.getElementById("text");

speakBtn.addEventListener("click", async () => {
  const text = textEl.value.trim();
  if (!text) return;

  speakBtn.disabled = true;
  statusEl.textContent = "calling ElevenLabs...";

  try {
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `request failed (${r.status})`);
    }

    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    player.src = url;
    await player.play();
    statusEl.textContent = "playing";
  } catch (err) {
    statusEl.textContent = "error: " + err.message;
  } finally {
    speakBtn.disabled = false;
  }
});
