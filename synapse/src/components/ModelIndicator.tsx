import { useEffect, useState } from "react";
import { socket } from "../socket";

const COLORS: Record<string, string> = {
  groq: "bg-emerald-500",
  gemini: "bg-blue-500",
  cerebras: "bg-orange-500",
  ollama: "bg-slate-500",
  ollama_1: "bg-slate-500",
  ollama_2: "bg-slate-400",
};

const LABELS: Record<string, string> = {
  groq: "Groq · Llama 3.3 70B",
  gemini: "Gemini 2.0 Flash",
  cerebras: "Cerebras · Llama 3.1 70B",
  ollama: "Ollama · Local",
  ollama_1: "Ollama · Local 1",
  ollama_2: "Ollama · Local 2",
};

export function ModelIndicator() {
  const [provider, setProvider] = useState<string>("auto");
  const [status, setStatus] = useState<string>("idle");

  useEffect(() => {
    const onProviderUpdate = (data: { provider: string; status?: string }) => {
      setProvider(data.provider ?? "auto");
      setStatus(data.status ?? "active");
    };
    socket.on("provider_update", onProviderUpdate);
    return () => { socket.off("provider_update", onProviderUpdate); };
  }, []);

  return (
    <div className="flex items-center gap-2 text-xs text-gray-400">
      <div className={`w-2 h-2 rounded-full ${COLORS[provider] ?? "bg-gray-500"}`} />
      <span>
        {LABELS[provider] ?? "Selecting provider..."}
        {status === "rate_limited" ? " · rate limited" : ""}
      </span>
    </div>
  );
}
