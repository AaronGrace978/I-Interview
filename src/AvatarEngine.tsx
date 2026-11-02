import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Cpu,
  Film,
  LoaderCircle,
  Mic,
  RefreshCw,
  ShieldCheck,
  Square,
  Video,
  Volume2,
} from "lucide-react";
import {
  avatarIdSchema,
  type AvatarJob,
  type AvatarSpeech,
  type AvatarStatus,
  type GpuStatus,
} from "./avatar-contracts";
import { bridge, desktop } from "./platform";

type Engine = {
  status: AvatarStatus | null;
  gpu: GpuStatus | null;
  job: AvatarJob | null;
  stream: MediaStream | null;
  connected: boolean;
  connecting: boolean;
  working: boolean;
  error: string;
  notice: string;
  videoReady: boolean;
  needsAudio: boolean;
  decodedFps: number | null;
  voiceMode: AvatarSpeech["mode"];
  setVoiceMode: (mode: AvatarSpeech["mode"]) => void;
  check: () => Promise<void>;
  checkGpu: () => Promise<void>;
  saveToken: (token: string) => Promise<void>;
  prepare: (id: string, consent: boolean) => Promise<void>;
  importVoice: (consent: boolean) => Promise<void>;
  connect: (id: string, consent: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
  speak: (text: string, voiceId: string) => Promise<{ startedMs: number }>;
  interrupt: () => Promise<void>;
  markReady: () => void;
  enableAudio: () => Promise<void>;
};
const Context = createContext<Engine | null>(null);
export function useAvatarEngine() {
  const engine = useContext(Context);
  if (!engine) throw new Error("Avatar engine provider is missing.");
  return engine;
}

export function AvatarEngineProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AvatarStatus | null>(null);
  const [gpu, setGpu] = useState<GpuStatus | null>(null);
  const [job, setJob] = useState<AvatarJob | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [videoReady, setVideoReady] = useState(false);
  const [needsAudio, setNeedsAudio] = useState(false);
  const [decodedFps, setDecodedFps] = useState<number | null>(null);
  const [voiceMode, setVoiceMode] = useState<AvatarSpeech["mode"]>("local");
  const pc = useRef<RTCPeerConnection | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const operation = useRef(0);
  const mounted = useRef(true);
  const locked = useRef(false);
  useEffect(() => {
    if (!connected) {
      setDecodedFps(null);
      return;
    }
    let previous: { frames: number; time: number } | null = null;
    let canceled = false;
    const timer = setInterval(() => {
      void pc.current
        ?.getStats()
        .then((report) => {
          if (canceled) return;
          report.forEach((entry: RTCInboundRtpStreamStats) => {
            if (
              entry.type !== "inbound-rtp" ||
              entry.kind !== "video" ||
              entry.framesDecoded === undefined
            )
              return;
            if (previous && entry.timestamp > previous.time)
              setDecodedFps(
                Math.max(
                  0,
                  ((entry.framesDecoded - previous.frames) * 1000) /
                    (entry.timestamp - previous.time),
                ),
              );
            previous = { frames: entry.framesDecoded, time: entry.timestamp };
          });
        })
        .catch(() => {});
    }, 1000);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [connected]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current++;
      pc.current?.close();
      audio.current?.pause();
      if (desktop && pc.current)
        void bridge()
          .avatarStop()
          .catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!stream) {
      audio.current?.pause();
      if (audio.current) audio.current.srcObject = null;
      return;
    }
    const player = new Audio();
    audio.current = player;
    player.srcObject = stream;
    void player.play().catch(() => {
      if (mounted.current) setNeedsAudio(true);
    });
    return () => {
      player.pause();
      player.srcObject = null;
    };
  }, [stream]);
  const execute = async (task: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      locked.current = false;
      if (mounted.current) setWorking(false);
    }
  };
  async function check() {
    await execute(async () => {
      const result = await bridge().avatarStatus();
      if (mounted.current) setStatus(result);
    });
  }
  async function checkGpu() {
    await execute(async () => {
      const result = await bridge().avatarGpu();
      if (mounted.current) {
        setGpu(result);
        setNotice(
          "CUDA kernels executed successfully on your GPU. Video frame rate still needs a real stream test.",
        );
      }
    });
  }
  async function saveToken(token: string) {
    await execute(async () => {
      await bridge().saveCredential("avatar_engine", token.trim());
      const result = await bridge().avatarStatus();
      if (mounted.current) {
        setStatus(result);
        setNotice(
          "Local engine connected. The token is encrypted by your operating system.",
        );
      }
    });
  }
  async function prepare(id: string, consent: boolean) {
    await execute(async () => {
      avatarIdSchema.parse(id);
      if (!consent) throw new Error("Confirm that this is your own footage.");
      const result = await bridge().avatarPrepare(id, true);
      if (mounted.current && result) setJob(result);
    });
  }
  async function importVoice(consent: boolean) {
    await execute(async () => {
      if (!consent)
        throw new Error("Confirm that the voice reference is yours.");
      if (await bridge().avatarImportVoice(true))
        setNotice(
          "Your local voice reference is saved on the engine machine. Chatterbox will use it for your replica's speech.",
        );
    });
  }
  useEffect(() => {
    if (!job || ["completed", "failed"].includes(job.status)) return;
    let canceled = false;
    const timer = setInterval(() => {
      void bridge()
        .avatarJob(job.task_id)
        .then((result) => {
          if (canceled) return;
          setJob(result);
          if (result.status === "completed")
            void bridge()
              .avatarStatus()
              .then((value) => {
                if (!canceled) setStatus(value);
              });
          if (result.status === "failed")
            setError(result.error || "Video preparation failed.");
        })
        .catch((error) => {
          if (!canceled) {
            setError(error instanceof Error ? error.message : String(error));
            setJob((current) =>
              current
                ? {
                    ...current,
                    status: "failed",
                    error: "Engine connection was lost.",
                  }
                : null,
            );
          }
        });
    }, 2000);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [job?.task_id, job?.status]);
  async function disconnect() {
    const hadSession = Boolean(pc.current) || connected || connecting;
    operation.current++;
    pc.current?.close();
    pc.current = null;
    setStream(null);
    setConnected(false);
    setConnecting(false);
    setVideoReady(false);
    setNeedsAudio(false);
    if (!desktop || !hadSession) return;
    try {
      await bridge().avatarStop();
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : String(error));
    }
  }
  async function connect(id: string, consent: boolean) {
    if (connecting || connected) return;
    if (!consent) {
      setError(
        "Confirm consent and disclosure before starting the video replica.",
      );
      return;
    }
    try {
      avatarIdSchema.parse(id);
    } catch {
      setError("Choose a prepared avatar ID.");
      return;
    }
    const current = ++operation.current;
    setConnecting(true);
    setError("");
    setVideoReady(false);
    const peer = new RTCPeerConnection({ iceServers: [] });
    pc.current = peer;
    const media = new MediaStream();
    peer.addTransceiver("video", { direction: "recvonly" });
    peer.addTransceiver("audio", { direction: "recvonly" });
    peer.ontrack = (event) => {
      if (current !== operation.current) return;
      if (!media.getTrackById(event.track.id)) media.addTrack(event.track);
      setStream(new MediaStream(media.getTracks()));
    };
    peer.onconnectionstatechange = () => {
      if (current !== operation.current || !mounted.current) return;
      if (peer.connectionState === "connected") {
        setConnected(true);
        setConnecting(false);
      }
      if (peer.connectionState === "failed") {
        setError(
          "The video transport failed. Check WSL2/Windows networking and reconnect.",
        );
        void disconnect();
      }
    };
    try {
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== "complete")
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            peer.removeEventListener("icegatheringstatechange", change);
            reject(new Error("Local video candidate gathering timed out."));
          }, 15000);
          const change = () => {
            if (peer.iceGatheringState === "complete") {
              clearTimeout(timeout);
              peer.removeEventListener("icegatheringstatechange", change);
              resolve();
            }
          };
          peer.addEventListener("icegatheringstatechange", change);
        });
      const answer = await bridge().avatarOffer(
        id,
        peer.localDescription!.sdp,
        true,
      );
      if (current !== operation.current) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      await new Promise<void>((resolve, reject) => {
        if (peer.connectionState === "connected") {
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          peer.removeEventListener("connectionstatechange", change);
          reject(
            new Error(
              "The renderer answered, but WebRTC did not connect within 20 seconds. Check candidate reachability.",
            ),
          );
        }, 20000);
        const change = () => {
          if (
            ["connected", "failed", "closed"].includes(peer.connectionState)
          ) {
            clearTimeout(timeout);
            peer.removeEventListener("connectionstatechange", change);
            if (peer.connectionState === "connected") resolve();
            else reject(new Error("Video connection stopped."));
          }
        };
        peer.addEventListener("connectionstatechange", change);
      });
    } catch (error) {
      if (current === operation.current && mounted.current) {
        setError(error instanceof Error ? error.message : String(error));
        peer.close();
        pc.current = null;
        setStream(null);
        setConnected(false);
        setConnecting(false);
        void bridge()
          .avatarStop()
          .catch(() => {});
      }
    }
  }
  const markReady = useCallback(() => setVideoReady(true), []);
  async function enableAudio() {
    try {
      await audio.current?.play();
      setNeedsAudio(false);
    } catch {
      setError(
        "Audio playback was blocked. Check your selected output device and try again.",
      );
    }
  }
  async function speak(text: string, voiceId: string) {
    if (!connected || !videoReady)
      throw new Error(
        "Connect your video replica and wait for real video frames before speaking.",
      );
    return bridge().avatarSpeak({
      text,
      mode: voiceMode,
      ...(voiceMode === "elevenlabs" ? { voiceId } : {}),
    });
  }
  async function interrupt() {
    if (connected || connecting) await bridge().avatarInterrupt();
  }
  return (
    <Context.Provider
      value={{
        status,
        gpu,
        job,
        stream,
        connected,
        connecting,
        working,
        error,
        notice,
        videoReady,
        needsAudio,
        decodedFps,
        voiceMode,
        setVoiceMode,
        check,
        checkGpu,
        saveToken,
        prepare,
        importVoice,
        connect,
        disconnect,
        speak,
        interrupt,
        markReady,
        enableAudio,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function ReplicaStage({ compact = false }: { compact?: boolean }) {
  const engine = useAvatarEngine();
  const element = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (element.current) {
      element.current.srcObject = engine.stream;
      if (engine.stream) void element.current.play().catch(() => {});
    }
  }, [engine.stream]);
  return (
    <div className={`replica-stage ${compact ? "compact" : ""}`}>
      <video
        ref={element}
        autoPlay
        playsInline
        muted
        onLoadedData={(event) => {
          if (
            event.currentTarget.videoWidth > 0 &&
            event.currentTarget.videoHeight > 0
          )
            engine.markReady();
        }}
        aria-label="Live video of your AI replica"
      />
      <span className="replica-video-badge">
        <ShieldCheck size={12} /> AI VIDEO REPRESENTATIVE
      </span>
      {!engine.videoReady && (
        <div className="replica-video-empty">
          {engine.connecting ? (
            <LoaderCircle size={36} className="spin" />
          ) : (
            <Video size={36} />
          )}
          <h3>
            {engine.connecting
              ? "Connecting to your GPU renderer…"
              : "Your moving video replica"}
          </h3>
          <p>
            Real frames from your own prepared footage will appear here. No
            stock face or simulated video.
          </p>
        </div>
      )}
      {engine.needsAudio && (
        <button
          className="secondary-button replica-enable-audio"
          onClick={() => void engine.enableAudio()}
        >
          <Volume2 size={14} />
          Enable stream audio
        </button>
      )}
      <span className="replica-live-state">
        <span className="status-dot" />
        {engine.videoReady
          ? `Receiving real video frames${engine.decodedFps === null ? "" : ` · ${engine.decodedFps.toFixed(1)} decoded fps`}`
          : engine.connected
            ? "Transport connected · waiting for frames"
            : engine.connecting
              ? "Connecting video transport"
              : "Not connected"}
      </span>
    </div>
  );
}

export default function VideoReplica() {
  const engine = useAvatarEngine();
  const [token, setToken] = useState("");
  const [avatarId, setAvatarId] = useState("aaron");
  const [consent, setConsent] = useState(false);
  const preparing =
    engine.job && ["pending", "running"].includes(engine.job.status);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span /> SELF-HOSTED ON YOUR GPU
          </div>
          <h1>Your face. In motion.</h1>
          <p>
            A video replica built from your footage, animated by your speech,
            and streamed from your own machine.
          </p>
        </div>
        <Video size={40} strokeWidth={1} />
      </div>
      <div className="hardware-strip">
        <Cpu size={18} />
        <strong>RTX 5060 Ti · 16 GB VRAM</strong>
        <span>Ryzen 7 3700X · 32 GB RAM</span>
        <span>One stream · batch 4 · 25 fps target</span>
      </div>
      {engine.error && (
        <div className="alert error" role="alert">
          {engine.error}
        </div>
      )}
      {engine.notice && (
        <div className="alert notice" role="status">
          {engine.notice}
        </div>
      )}
      <div className="replica-setup-grid">
        <div>
          <section className="card settings-card">
            <h2>1. Connect your local video engine</h2>
            <p>
              Start the WSL2 GPU engine on your NVIDIA machine, then enter its
              local token. The desktop app only contacts 127.0.0.1:17860. Your
              footage stays on that machine.
            </p>
            <label>
              Local engine token
              <input
                aria-label="Local engine token"
                type="password"
                autoComplete="off"
                value={token}
                maxLength={512}
                onChange={(event) => setToken(event.target.value)}
                placeholder="From ~/.i-interview-avatar/engine-token"
                disabled={!desktop || engine.working}
              />
            </label>
            <div className="replica-button-row">
              <button
                className="primary-button"
                disabled={
                  !desktop || engine.working || token.trim().length < 32
                }
                onClick={() => {
                  void engine.saveToken(token).then(() => setToken(""));
                }}
              >
                {engine.working ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <ShieldCheck size={14} />
                )}
                Save engine connection
              </button>
              <button
                className="secondary-button"
                disabled={!desktop || engine.working}
                onClick={() => void engine.check()}
              >
                <RefreshCw size={14} />
                Check engine
              </button>
            </div>
            {engine.status && (
              <p className="inline-hint">{engine.status.message}</p>
            )}
            <button
              className="secondary-button"
              disabled={
                !desktop || engine.working || !engine.status?.configured
              }
              onClick={() => void engine.checkGpu()}
            >
              <Cpu size={14} />
              Validate CUDA kernels
            </button>
            {engine.gpu && (
              <p className="inline-hint">
                {engine.gpu.device} · {engine.gpu.vram_gib} GB · CUDA{" "}
                {engine.gpu.cuda} · kernel check{" "}
                {engine.gpu.kernel_check ? "passed" : "failed"}
              </p>
            )}
          </section>
          <section className="card settings-card">
            <h2>2. Prepare your face and voice</h2>
            <p>
              Use a clear video of yourself with natural blinking, small head
              movements, and a relaxed smile. The initial profile uses up to 12
              seconds at a maximum of 720 × 720 to bound memory use. MuseTalk
              animates the mouth; other motion comes from your footage.
            </p>
            <label>
              Replica ID
              <input
                aria-label="Replica ID"
                value={avatarId}
                maxLength={64}
                onChange={(event) => setAvatarId(event.target.value)}
                disabled={Boolean(preparing) || engine.connected}
                placeholder="aaron"
              />
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
                disabled={engine.connected || engine.connecting}
              />
              The video and voice are mine. I consent to creating this replica,
              and its participation will be disclosed and permitted.
            </label>
            <div className="replica-button-row">
              <button
                className="secondary-button"
                disabled={
                  !desktop ||
                  !consent ||
                  engine.working ||
                  Boolean(preparing) ||
                  engine.connected ||
                  !engine.status?.configured
                }
                onClick={() => void engine.prepare(avatarId, consent)}
              >
                <Film size={14} />
                Choose my footage and prepare
              </button>
              <button
                className="secondary-button"
                disabled={!desktop || !consent || engine.working}
                onClick={() => void engine.importVoice(consent)}
              >
                <Mic size={14} />
                Import my voice sample
              </button>
            </div>
            {engine.job && (
              <p role="status" className="inline-hint">
                Preparation: {engine.job.status}
                {engine.job.error ? ` · ${engine.job.error}` : ""}.{" "}
                {preparing ? "GPU preparation is running on your machine." : ""}
              </p>
            )}
            <label className="replica-voice-label">
              Voice source
              <select
                aria-label="Replica voice source"
                value={engine.voiceMode}
                onChange={(event) =>
                  engine.setVoiceMode(
                    event.target.value as AvatarSpeech["mode"],
                  )
                }
                disabled={engine.connected}
              >
                <option value="local">Self-hosted Chatterbox-Nano · CPU</option>
                <option value="elevenlabs">
                  My consented ElevenLabs voice
                </option>
              </select>
            </label>
            <small>
              CPU voice synthesis has a separate runtime so it cannot downgrade
              the Blackwell video runtime. Voice latency and likeness still
              require measurement.
            </small>
          </section>
        </div>
        <section className="card replica-preview-card">
          <ReplicaStage />
          <div className="replica-preview-controls">
            <label>
              Prepared replica
              <select
                aria-label="Prepared replica"
                value={
                  engine.status?.avatars.includes(avatarId) ? avatarId : ""
                }
                onChange={(event) => setAvatarId(event.target.value)}
                disabled={engine.connected || engine.connecting}
              >
                <option value="" disabled>
                  Select your prepared replica
                </option>
                {engine.status?.avatars.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            {engine.connected || engine.connecting ? (
              <button
                className="stop-button"
                onClick={() => void engine.disconnect()}
              >
                <Square size={14} />
                Disconnect video
              </button>
            ) : (
              <button
                className="primary-button"
                disabled={
                  !desktop ||
                  !consent ||
                  !engine.status?.avatars.includes(avatarId) ||
                  Boolean(preparing)
                }
                onClick={() => void engine.connect(avatarId, consent)}
              >
                <Video size={15} />
                Start my video replica
              </button>
            )}
            <p>
              Once real frames arrive, open Interview delegate to generate
              answers and drive your replica's synchronized speech. An image
              alone does not become a complete animated person in this release.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
