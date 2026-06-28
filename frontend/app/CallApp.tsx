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

const SILENCE_RMS_THRESHOLD = 0.018; // 0..1, tune for mic; higher = less sensitive to noise
const MIN_SPEECH_MS = 400; // first contiguous burst must last this long to count as speech
const MIN_TOTAL_SPEECH_MS = 600; // minimum cumulative speech in an utterance before we send it; rejects brief noise bursts
const SILENCE_HANGOVER_MS = 550; // ms of silence before we flush to backend; lower = snappier, higher = patient with slow speakers
const POST_AGENT_COOLDOWN_MS = 300; // ignore mic for this long after the agent stops speaking, to avoid speaker tail-bleed
const POLL_INTERVAL_MS = 50;

// Amplitude (RMS) that maps to a "fully open" orb.
const AMP_FULL = 0.22;

export default function CallApp() {
  const [status, setStatus] = useState<Status>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [partial, setPartial] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);

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
  const totalSpeechMsRef = useRef(0);
  const cooldownUntilRef = useRef(0);
  const discardNextRef = useRef(false);

  // Orb animation plumbing (imperative — driven by refs, never re-renders).
  const orbRef = useRef<HTMLDivElement | null>(null);
  const levelRef = useRef(0); // latest mic RMS
  const ampSmoothRef = useRef(0);
  const statusRef = useRef<Status>("idle");
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

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
      cooldownUntilRef.current = performance.now() + POST_AGENT_COOLDOWN_MS;
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
      const discard = discardNextRef.current;
      discardNextRef.current = false;
      if (
        !discard &&
        ws &&
        ws.readyState === WebSocket.OPEN &&
        blob.size > 0
      ) {
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
        totalSpeechMsRef.current = 0;
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
      const now = performance.now();
      if (now < cooldownUntilRef.current) return;

      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      levelRef.current = rms; // feed the orb
      const speaking = rms > SILENCE_RMS_THRESHOLD;

      if (speaking) {
        if (speechStartedAtRef.current === null) {
          speechStartedAtRef.current = now;
          setStatus("user-speaking");
        }
        lastVoiceAtRef.current = now;
        totalSpeechMsRef.current += POLL_INTERVAL_MS;
      } else if (
        speechStartedAtRef.current !== null &&
        lastVoiceAtRef.current !== null
      ) {
        const speechDur = now - speechStartedAtRef.current;
        const silenceDur = now - lastVoiceAtRef.current;
        if (speechDur >= MIN_SPEECH_MS && silenceDur >= SILENCE_HANGOVER_MS) {
          // Only send to backend if there was enough actual speech.
          // Otherwise it's just background noise — discard silently.
          if (totalSpeechMsRef.current < MIN_TOTAL_SPEECH_MS) {
            discardNextRef.current = true;
          }
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
    levelRef.current = 0;
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
          const text = String(msg.text ?? "").trim();
          if (text) {
            appendTurn("caller", text);
          } else {
            // Server filtered out a hallucination or empty utterance — go back to listening silently.
            setStatus((s) => (s === "thinking" ? "listening" : s));
          }
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
    setSeconds(0);
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
      setErrorMsg("Microphone access is blocked. Allow it, then start the call again.");
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
      setErrorMsg("Couldn't reach the call server. Check that the backend is running.");
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

  // Keep a ref copy of status for the rAF loop.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const inCall = status !== "idle" && status !== "ended" && status !== "error";

  // Call timer — ticks while a call is live, holds its final value afterwards.
  useEffect(() => {
    if (!inCall) return;
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [inCall]);

  // Auto-scroll transcript to the newest turn.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, partial]);

  // The orb's heartbeat: translate call state + live amplitude into a single
  // smoothed `--amp` the CSS reads. Mic levels are real; Maya's speech (no mic
  // analyser) gets an organic synthetic motion so she still feels alive.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = orbRef.current;
      if (el) {
        const s = statusRef.current;
        let target = 0;
        if (s === "user-speaking") {
          target = Math.min(1, levelRef.current / AMP_FULL);
        } else if (s === "listening") {
          target = 0.1 + Math.min(0.25, (levelRef.current / AMP_FULL) * 0.25);
        } else if (s === "agent-speaking") {
          const t = performance.now() / 1000;
          const wobble =
            0.5 + 0.5 * Math.sin(t * 7.3) * (0.6 + 0.4 * Math.sin(t * 2.9));
          target = 0.42 + 0.4 * wobble;
        } else if (s === "thinking" || s === "connecting") {
          target = 0.18;
        }
        // critically-damped-ish smoothing toward target
        ampSmoothRef.current += (target - ampSmoothRef.current) * 0.16;
        el.style.setProperty("--amp", ampSmoothRef.current.toFixed(3));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <main className="flex flex-1 flex-col items-center px-5 py-10 sm:py-14">
      <div className="flex w-full max-w-3xl flex-col gap-10">
        {/* masthead */}
        <header className="flex items-center justify-between">
          <div className="flex items-baseline gap-2.5">
            <span className="font-display text-xl font-semibold tracking-tight text-text">
              Nexbizio
            </span>
            <span className="mono text-[0.62rem] uppercase tracking-[0.22em] text-dim">
              Voice Agent
            </span>
          </div>
          <Telemetry status={status} seconds={seconds} />
        </header>

        {/* hero: the call console */}
        <section className="flex flex-col items-center gap-7 pt-2 text-center">
          <Orb ref={orbRef} status={status} />

          <div className="flex flex-col items-center gap-1.5">
            <h1 className="font-display text-[1.7rem] font-medium leading-tight tracking-tight text-text">
              {headline(status)}
            </h1>
            <p className="max-w-md text-sm leading-relaxed text-dim">
              {subline(status)}
            </p>
          </div>

          <div className="flex flex-col items-center gap-3">
            {!inCall ? (
              <button onClick={startCall} className="btn-call btn-start">
                <span className="btn-dot" />
                {status === "ended" || status === "error"
                  ? "Call again"
                  : "Start call"}
              </button>
            ) : (
              <button onClick={endCall} className="btn-call btn-end">
                <span className="btn-dot" />
                End call
              </button>
            )}
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="mt-1 max-w-md rounded-lg border border-[rgba(255,107,107,0.4)] bg-[rgba(255,107,107,0.08)] px-4 py-3 text-sm text-[#ffb4b4]"
            >
              {errorMsg}
            </div>
          )}
        </section>

        {/* transcript */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="mono text-[0.66rem] uppercase tracking-[0.16em] text-dim">
              Transcript
            </h2>
            {turns.length > 0 && (
              <span className="mono text-[0.66rem] text-dim">
                {turns.length} {turns.length === 1 ? "turn" : "turns"}
              </span>
            )}
          </div>

          <div className="glass scroll-area flex max-h-[42vh] min-h-[200px] flex-col gap-4 overflow-y-auto rounded-2xl p-5">
            {turns.length === 0 && !partial ? (
              <div className="m-auto flex flex-col items-center gap-1.5 py-8 text-center">
                <p className="font-display text-sm text-dim">
                  No words exchanged yet
                </p>
                <p className="max-w-xs text-xs leading-relaxed text-[var(--text-faint)]">
                  Start the call and say hello. Everything you and Maya say lands
                  here, line by line.
                </p>
              </div>
            ) : (
              <>
                {turns.map((t, i) => (
                  <TurnRow key={i} role={t.role} text={t.text} />
                ))}
                {partial && <TurnRow role="agent" text={partial} pending />}
                <div ref={transcriptEndRef} />
              </>
            )}
          </div>
        </section>
      </div>

      <audio ref={playbackElRef} hidden />
    </main>
  );
}

const Orb = ({
  ref,
  status,
}: {
  ref: React.Ref<HTMLDivElement>;
  status: Status;
}) => {
  return (
    <div ref={ref} className="orb-stage" data-state={status}>
      <div className="orb-ring r1" />
      <div className="orb-ring r2" />
      <div className="orb-ring r3" />
      <div className="orb-arc" />
      <div className="orb-core" />
    </div>
  );
};

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
    <div className="turn-in flex gap-3">
      <span className={`turn-tag shrink-0 ${isAgent ? "agent" : "caller"}`}>
        {isAgent ? "Maya" : "You"}
      </span>
      <p
        className={`text-sm leading-relaxed text-text/90 ${
          pending ? "opacity-80" : ""
        }`}
      >
        {text}
        {pending && <span className="caret">.</span>}
      </p>
    </div>
  );
}

function Telemetry({ status, seconds }: { status: Status; seconds: number }) {
  const live = status !== "idle" && status !== "ended" && status !== "error";
  const label =
    status === "idle"
      ? "Standby"
      : status === "ended"
        ? "Ended"
        : status === "error"
          ? "Offline"
          : "Live";
  return (
    <div
      className="orb-stage flex items-center gap-2"
      data-state={status}
      style={{ width: "auto", height: "auto" }}
    >
      <span className={`live-dot ${live ? "pulsing" : ""}`} />
      <span className="mono text-[0.7rem] uppercase tracking-[0.14em] text-dim">
        {label}
      </span>
      {(live || status === "ended") && (
        <span className="mono text-[0.7rem] tabular-nums text-text/70">
          {fmt(seconds)}
        </span>
      )}
    </div>
  );
}

function fmt(total: number) {
  const m = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function headline(status: Status): string {
  switch (status) {
    case "idle":
      return "Talk to Maya";
    case "connecting":
      return "Connecting…";
    case "listening":
      return "Listening";
    case "user-speaking":
      return "Go ahead, I'm with you";
    case "thinking":
      return "Thinking it through…";
    case "agent-speaking":
      return "Maya's speaking";
    case "ended":
      return "Call ended";
    case "error":
      return "Call interrupted";
  }
}

function subline(status: Status): string {
  switch (status) {
    case "idle":
      return "Maya is the Nexbizio voice agent. Start the call, allow your mic, and have a real conversation about the B2B marketplace.";
    case "connecting":
      return "Setting up the line and waking Maya up.";
    case "listening":
      return "The line is open. Just start talking whenever you're ready.";
    case "user-speaking":
      return "Keep going — Maya picks up when you pause.";
    case "thinking":
      return "Maya is working out a reply.";
    case "agent-speaking":
      return "Listen in. You can jump back in as soon as she finishes.";
    case "ended":
      return "Thanks for talking with Maya. Start another call whenever you like.";
    case "error":
      return "The connection dropped. You can try the call again.";
  }
}
