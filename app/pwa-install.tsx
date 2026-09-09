"use client";

import { useEffect, useState } from "react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function PwaInstallButton({ compact = false }: { compact?: boolean }) {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
    const standaloneMedia = window.matchMedia("(display-mode: standalone)");
    const syncStandalone = () => setInstalled(
      standaloneMedia.matches
      || ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
    );
    queueMicrotask(syncStandalone);
    const capturePrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const markInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", capturePrompt);
    window.addEventListener("appinstalled", markInstalled);
    standaloneMedia.addEventListener("change", syncStandalone);
    return () => {
      window.removeEventListener("beforeinstallprompt", capturePrompt);
      window.removeEventListener("appinstalled", markInstalled);
      standaloneMedia.removeEventListener("change", syncStandalone);
    };
  }, []);

  if (installed) return null;

  async function install() {
    if (!prompt) {
      setShowHelp((value) => !value);
      return;
    }
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") setInstalled(true);
    setPrompt(null);
  }

  return <div className={`pwa-install ${compact ? "compact" : ""}`}>
    <button type="button" className="pwa-install-button" onClick={install}>
      <span className="material-symbols-rounded" aria-hidden="true">install_mobile</span>
      <span>Installa app</span>
    </button>
    {showHelp && <p>iPhone: Condividi → Aggiungi alla schermata Home.<br />Android: menu del browser → Installa app.</p>}
  </div>;
}
