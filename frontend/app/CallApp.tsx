"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/call";

type TurnRole = "agent" | "caller";
type Turn = { role: TurnRole; text: string };

type Status =
  | "idle"
  | "connecting"
  | "listening"
  | "user-speaking"
  | "thinking"
  | "agent-speaking"
  | "ended"
  | "error";

const SILENCE_RMS_THRESHOLD = 0.012; // 0..1, tune for mic
const MIN_SPEECH_MS = 250;
const SILENCE_HANGOVER_MS = 900;
const POLL_INTERVAL_MS = 60;

export default function CallApp() {
  const [status, setStatus] = useState<Status>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [partial, setPartial] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadTimerRef = useRef<number | null>(null);
  const audioQueueRef = useRef<Blob[]>([]);
  const audioBufferRef = useRef<BlobPart[]>([]);
  const audioMimeRef = useRef<string>("audio/mpeg");
  const playbackElRef = useRef<HTMLAudioElement | null>(null);
  const isAgentSpeakingRef = useRef(false);
  const partialRef = useRef("");

  const speechStartedAtRef = useRef<number | null>(null);
  const lastVoiceAtRef = useRef<number | null>(null);

  const log = useCallback((..._args: unknown[]) => {
    if (process.env.NODE_ENV !== "production") {
      console.log("[call]", ..._args);
    }
  }, []);

  const appendTurn = useCallback((role: TurnRole, text: string) => {
    if (!text.trim()) return;
    setTurns((t) => [...t, { role, text }]);
  }, []);

  const playNextInQueue = useCallback(() => {
    const el = playbackElRef.current;
    if (!el) return;
    if (!el.paused) return;
    const next = audioQueueRef.current.shift();
    if (!next) {
      isAgentSpeakingRef.current = false;
      setStatus((s) => (s === "agent-speaking" ? "listening" : s));
      return;
    }
    isAgentSpeakingRef.current = true;
    setStatus("agent-speaking");
    const url = URL.createObjectURL(next);
    el.src = url;
    el.onended = () => {
      URL.revokeObjectURL(url);
      playNextInQueue();
    };
    el.play().catch((e) => {
      log("audio play failed", e);
      URL.revokeObjectURL(url);
      playNextInQueue();
    });
  }, [log]);

  const stopVad = useCallback(() => {
    if (vadTimerRef.current !== null) {
      window.clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
  }, []);

  const flushUtterance = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (rec.state === "recording") {
      rec.stop(); // triggers ondataavailable + onstop
    }
  }, []);

  const startRecorder = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!stream) return;
    const mimeCandidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
    ];
    const mime =
      mimeCandidates.find((m) =>
        typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)
      ) ?? "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      const ws = wsRef.current;
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (ws && ws.readyState === WebSocket.OPEN && blob.size > 0) {
        blob.arrayBuffer().then((buf) => {
          ws.send(buf);
          ws.send(JSON.stringify({ type: "user_audio_end" }));
          setStatus("thinking");
        });
      }
      // restart for next utterance unless call ended
      if (status !== "ended") {
        speechStartedAtRef.current = null;
        lastVoiceAtRef.current = null;
        startRecorder();
      }
    };
    recorderRef.current = rec;
    rec.start(250);
  }, [status]);

  const startVad = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Uint8Array(analyser.fftSize);

    vadTimerRef.current = window.setInterval(() => {
      if (isAgentSpeakingRef.current) return;

      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      const now = performance.now();
      const speaking = rms > SILENCE_RMS_THRESHOLD;

      if (speaking) {
        if (speechStartedAtRef.current === null) {
          speechStartedAtRef.current = now;
          setStatus("user-speaking");
        }
        lastVoiceAtRef.current = now;
      } else if (
        speechStartedAtRef.current !== null &&
        lastVoiceAtRef.current !== null
      ) {
        const speechDur = now - speechStartedAtRef.current;
        const silenceDur = now - lastVoiceAtRef.current;
        if (speechDur >= MIN_SPEECH_MS && silenceDur >= SILENCE_HANGOVER_MS) {
          flushUtterance();
        }
      }
    }, POLL_INTERVAL_MS);
  }, [flushUtterance]);

  const cleanup = useCallback(() => {
    stopVad();
    try {
      recorderRef.current?.stop();
    } catch {}
    recorderRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: "end" }));
      } catch {}
      wsRef.current.close();
    }
    wsRef.current = null;
    audioQueueRef.current = [];
    audioBufferRef.current = [];
    isAgentSpeakingRef.current = false;
  }, [stopVad]);

  const handleServerMessage = useCallback(
    (data: string) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "session":
          log("session", msg.session_id);
          break;
        case "user_transcript": {
          const text = String(msg.text ?? "");
          appendTurn("caller", text || "(no speech detected)");
          break;
        }
        case "assistant_text_delta": {
          const t = String(msg.text ?? "");
          partialRef.current += t;
          setPartial(partialRef.current);
          break;
        }
        case "assistant_text_done": {
          const text = String(msg.text ?? partialRef.current);
          appendTurn("agent", text);
          partialRef.current = "";
          setPartial("");
          break;
        }
        case "audio_start":
          audioBufferRef.current = [];
          audioMimeRef.current = String(msg.format ?? "audio/mpeg");
          break;
        case "audio_end": {
          if (audioBufferRef.current.length > 0) {
            const blob = new Blob(audioBufferRef.current, {
              type: audioMimeRef.current,
            });
            audioBufferRef.current = [];
            audioQueueRef.current.push(blob);
            playNextInQueue();
          }
          break;
        }
        case "call_ended":
          setStatus("ended");
          cleanup();
          break;
        case "error":
          setErrorMsg(String(msg.message ?? "server error"));
          break;
      }
    },
    [appendTurn, cleanup, log, playNextInQueue]
  );

  const startCall = useCallback(async () => {
    setErrorMsg(null);
    setTurns([]);
    setPartial("");
    partialRef.current = "";
    setStatus("connecting");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      setStatus("error");
      setErrorMsg("Microphone permission denied or unavailable.");
      log("getUserMedia failed", e);
      return;
    }
    mediaStreamRef.current = stream;

    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    src.connect(analyser);
    analyserRef.current = analyser;

    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      log("ws open");
      setStatus("listening");
      ws.send(JSON.stringify({ type: "start" }));
      startRecorder();
      startVad();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        handleServerMessage(ev.data);
      } else {
        audioBufferRef.current.push(ev.data as ArrayBuffer);
      }
    };
    ws.onerror = (e) => {
      log("ws error", e);
      setErrorMsg("WebSocket error — is the backend running?");
      setStatus("error");
    };
    ws.onclose = () => {
      log("ws close");
      if (status !== "ended" && status !== "error") {
        setStatus("ended");
      }
    };
  }, [handleServerMessage, log, startRecorder, startVad, status]);

  const endCall = useCallback(() => {
    setStatus("ended");
    cleanup();
  }, [cleanup]);

  useEffect(() => {
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inCall = status !== "idle" && status !== "ended" && status !== "error";

  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 dark:bg-black min-h-screen">
      <main className="flex flex-col w-full max-w-2xl px-6 py-12 gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Nexbizio Calling Agent
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Browser-based POC. Click <strong>Start call</strong>, allow mic
            access, and talk to Maya — she&apos;ll pitch Nexbizio and respond
            naturally.
          </p>
        </header>

        <div className="flex items-center gap-4">
          {!inCall ? (
            <button
              onClick={startCall}
              className="rounded-full bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 font-medium transition-colors"
            >
              Start call
            </button>
          ) : (
            <button
              onClick={endCall}
              className="rounded-full bg-red-600 hover:bg-red-700 text-white px-6 py-3 font-medium transition-colors"
            >
              End call
            </button>
          )}
          <StatusPill status={status} />
        </div>

        {errorMsg && (
          <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950/40 dark:border-red-800/60 dark:text-red-200">
            {errorMsg}
          </div>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="text-sm uppercase tracking-wide text-zinc-500">
            Transcript
          </h2>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4 min-h-[280px] flex flex-col gap-3">
            {turns.length === 0 && !partial && (
              <p className="text-zinc-400 text-sm italic">
                Transcript will appear here once the call begins.
              </p>
            )}
            {turns.map((t, i) => (
              <TurnRow key={i} role={t.role} text={t.text} />
            ))}
            {partial && <TurnRow role="agent" text={partial} pending />}
          </div>
        </section>

        <audio ref={playbackElRef} hidden />
      </main>
    </div>
  );
}

function TurnRow({
  role,
  text,
  pending,
}: {
  role: TurnRole;
  text: string;
  pending?: boolean;
}) {
  const isAgent = role === "agent";
  return (
    <div className="flex gap-3">
      <span
        className={`shrink-0 text-xs font-semibold px-2 py-1 rounded ${
          isAgent
            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
            : "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200"
        }`}
      >
        {isAgent ? "Maya" : "You"}
      </span>
      <p
        className={`text-sm text-zinc-800 dark:text-zinc-200 ${
          pending ? "opacity-70" : ""
        }`}
      >
        {text}
        {pending && <span className="animate-pulse">▌</span>}
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  const map: Record<Status, { label: string; cls: string }> = {
    idle: { label: "Idle", cls: "bg-zinc-200 text-zinc-700" },
    connecting: { label: "Connecting…", cls: "bg-amber-200 text-amber-900" },
    listening: { label: "Listening", cls: "bg-emerald-200 text-emerald-900" },
    "user-speaking": {
      label: "You speaking…",
      cls: "bg-blue-200 text-blue-900",
    },
    thinking: { label: "Thinking…", cls: "bg-amber-200 text-amber-900" },
    "agent-speaking": {
      label: "Maya speaking…",
      cls: "bg-emerald-200 text-emerald-900",
    },
    ended: { label: "Call ended", cls: "bg-zinc-300 text-zinc-700" },
    error: { label: "Error", cls: "bg-red-200 text-red-900" },
  };
  const { label, cls } = map[status];
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}
