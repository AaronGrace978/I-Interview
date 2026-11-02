import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  Check,
  ChevronRight,
  CircleHelp,
  FileText,
  Fingerprint,
  Headphones,
  LayoutDashboard,
  LoaderCircle,
  Mic,
  Play,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  Video,
  X,
} from "lucide-react";
import {
  exportTranscript,
  MAX_ANSWER_LENGTH,
  MAX_RESUME_LENGTH,
  practiceFeedback,
  questions,
  type Feedback,
  type Message,
  type Profile,
} from "./domain";
import {
  bridge,
  cloneVoice,
  connectionStatus,
  desktop,
  nextQuestion,
  readResume,
  reviewAnswers,
  playVoice,
  stopVoice,
  type ModelConfig,
} from "./platform";
import { ProviderConnections, ModelControls, Updates } from "./Connections";
import Delegate from "./Delegate";
import VideoReplica, { useAvatarEngine } from "./AvatarEngine";
import type { KeyProvider } from "./contracts";

type Tab = "studio" | "replica" | "delegate" | "practice" | "settings";
const initialProfile: Profile = { name: "", role: "", resume: "" };

export default function App() {
  const avatarEngine = useAvatarEngine();
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
  const [tab, setTab] = useState<Tab>("studio");
  const [profile, setProfile] = useState<Profile>(initialProfile);
  const [portrait, setPortrait] = useState("");
  const [resumeName, setResumeName] = useState("");
  const [consent, setConsent] = useState(false);
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connections, setConnections] = useState<
    Partial<Record<KeyProvider, boolean>>
  >({});
  const [config, setConfig] = useState<ModelConfig>({
    provider: "openai",
    model: "",
  });
  const [delegateBusy, setDelegateBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [sessionMode, setSessionMode] = useState<"local" | "ai">("local");
  const [shareResume, setShareResume] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const portraitRef = useRef("");
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    connectionStatus()
      .then(setConnections)
      .catch(() =>
        setError(
          "Could not open the OS credential store. Check desktop keychain availability.",
        ),
      );
    return () => {
      if (portraitRef.current) URL.revokeObjectURL(portraitRef.current);
      stopVoice();
    };
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, busy]);

  async function run(label: string, operation: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }
  async function importResume(file?: File) {
    if (!file) return;
    await run("Reading resume", async () => {
      const resume = await readResume(file);
      setProfile((p) => ({ ...p, resume }));
      setResumeName(file.name);
      setNotice(
        "Resume extracted locally. Review the text before using AI coaching.",
      );
    });
  }
  async function importPortrait(file?: File) {
    if (!file) return;
    await run("Loading portrait", async () => {
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
        file.size > 5 * 1024 * 1024
      )
        throw new Error("Choose a JPG, PNG, or WebP smaller than 5 MB.");
      const bitmap = await createImageBitmap(file);
      bitmap.close();
      if (portraitRef.current) URL.revokeObjectURL(portraitRef.current);
      portraitRef.current = URL.createObjectURL(file);
      setPortrait(portraitRef.current);
    });
  }
  async function startSession() {
    await run("Preparing interview", async () => {
      if (!profile.resume.trim() || !profile.role.trim())
        throw new Error("Add your resume and target role first.");
      if (
        sessionMode === "ai" &&
        (!connections[config.provider] || !shareResume || !config.model.trim())
      )
        throw new Error(
          "Connect your selected provider, choose a model, and agree to share your resume and session for AI coaching.",
        );
      const question =
        sessionMode === "ai"
          ? await nextQuestion(profile, [], config)
          : questions[0];
      setMessages([{ role: "interviewer", content: question }]);
      setFeedback(null);
      setAnswer("");
      setTab("practice");
    });
  }
  async function submitAnswer() {
    const content = answer.trim();
    if (!content || content.length > MAX_ANSWER_LENGTH) return;
    await run("Preparing next question", async () => {
      const updated: Message[] = [...messages, { role: "candidate", content }];
      const count = updated.filter((m) => m.role === "candidate").length;
      if (count >= questions.length) {
        const review =
          sessionMode === "ai"
            ? await reviewAnswers(profile, updated, config)
            : practiceFeedback(updated);
        setMessages(updated);
        setFeedback(review);
        setAnswer("");
      } else {
        const question =
          sessionMode === "ai"
            ? await nextQuestion(profile, updated, config)
            : questions[count];
        setMessages([...updated, { role: "interviewer", content: question }]);
        setAnswer("");
      }
    });
  }
  function exportSession() {
    const url = URL.createObjectURL(
      new Blob([exportTranscript(profile, messages, feedback)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "i-interview-session.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function previewVoice() {
    await run("Generating voice preview", async () => {
      if (!consent)
        throw new Error(
          "Confirm that this is your own voice before generating audio.",
        );
      setSpeaking(true);
      try {
        await playVoice(
          voiceId,
          `Hi, I'm ${profile.name.trim() || "your interview partner"}. This is a disclosed AI-generated preview of my voice.`,
        );
      } finally {
        setSpeaking(false);
      }
    });
  }
  function clearWorkspace() {
    if (
      !window.confirm(
        "Clear your resume, portrait, voice reference, and session from this app? Provider-stored voices and saved API keys are managed separately.",
      )
    )
      return;
    stopVoice();
    setSpeaking(false);
    if (portraitRef.current) URL.revokeObjectURL(portraitRef.current);
    void avatarEngine.disconnect();
    setWorkspaceEpoch((n) => n + 1);
    portraitRef.current = "";
    setPortrait("");
    setProfile(initialProfile);
    setResumeName("");
    setVoiceFile(null);
    setVoiceId("");
    setConsent(false);
    setMessages([]);
    setFeedback(null);
    setAnswer("");
    setShareResume(false);
    setNotice("Workspace cleared.");
    setError("");
  }
  const steps = [
    Boolean(profile.resume.trim()),
    Boolean(portrait),
    Boolean(voiceId),
  ];
  const completed = steps.filter(Boolean).length;
  const sessionActive = (messages.length > 0 && !feedback) || delegateBusy;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            setTab("studio");
          }}
        >
          <span className="brand-icon">
            <AudioLines size={24} />
          </span>
          I / Interview<span className="brand-dot">®</span>
        </a>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button
            className={tab === "studio" ? "nav-item active" : "nav-item"}
            onClick={() => setTab("studio")}
          >
            <LayoutDashboard size={18} />
            Identity studio<span className="nav-pill">NEW</span>
          </button>
          <button
            className={tab === "replica" ? "nav-item active" : "nav-item"}
            onClick={() => setTab("replica")}
          >
            <Video size={18} />
            Video replica<span className="nav-pill">LOCAL</span>
          </button>
          <button
            className={tab === "delegate" ? "nav-item active" : "nav-item"}
            onClick={() => setTab("delegate")}
          >
            <AudioLines size={18} />
            Interview delegate
          </button>
          <button
            className={tab === "practice" ? "nav-item active" : "nav-item"}
            onClick={() => setTab("practice")}
          >
            <Headphones size={18} />
            Practice room
          </button>
          <button
            className={tab === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => setTab("settings")}
          >
            <Settings2 size={18} />
            Connections
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-card">
            <ShieldCheck size={21} />
            <strong>Your story stays yours.</strong>
            <p>
              Resume and portrait stay in memory until you choose to share. No
              background uploads.
            </p>
            <button onClick={() => setTab("settings")}>
              Privacy & connections <ArrowRight size={14} />
            </button>
          </div>
          <div className="account">
            <span className="account-avatar">
              {profile.name.trim().slice(0, 2).toUpperCase() || "YO"}
            </span>
            <div>
              <strong>{profile.name || "Your workspace"}</strong>
              <small>
                {desktop ? "Desktop edition" : "Local browser preview"}
              </small>
            </div>
            <span className="status-dot" />
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            Workspace <ChevronRight size={13} />{" "}
            <strong>
              {tab === "studio"
                ? "Identity studio"
                : tab === "replica"
                  ? "Video replica"
                  : tab === "delegate"
                    ? "Interview delegate"
                    : tab === "practice"
                      ? "Practice room"
                      : "Connections"}
            </strong>
          </span>
          <div className="topbar-right">
            <span className="private-status">
              <span className="status-dot" />
              Private by default
            </span>
            <button
              className="icon-button"
              aria-label="Help and privacy"
              onClick={() => setTab("settings")}
            >
              <CircleHelp size={18} />
            </button>
          </div>
        </header>
        <div className="page">
          {error && (
            <div className="alert error" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="alert notice" role="status">
              <span>{notice}</span>
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {busy && (
            <div className="busy-status" role="status">
              <LoaderCircle className="spin" size={15} />
              {busy}…
            </div>
          )}
          <div hidden={tab !== "replica"}>
            <VideoReplica />
          </div>
          <div hidden={tab !== "delegate"}>
            <Delegate
              key={workspaceEpoch}
              profile={profile}
              portrait={portrait}
              voiceId={voiceId}
              consent={consent}
              config={config}
              setConfig={setConfig}
              reportBusy={setDelegateBusy}
            />
          </div>
          {tab === "studio" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    <span /> THE NEXT CHAPTER IS YOURS
                  </div>
                  <h1>
                    Your experience.
                    <br />
                    Your voice. <em>Your advantage.</em>
                  </h1>
                  <p>
                    Bring your story to life. Build your identity, find your
                    voice,
                    <br className="desktop-break" /> let your approved
                    experience speak for itself.
                  </p>
                </div>
                <span className="edition-label">
                  THE IDENTITY STUDIO <span>01 / PREPARE</span>
                </span>
              </div>
              <div className="studio-grid">
                <div className="setup-column">
                  <div className="section-label">
                    <span>BUILD YOUR IDENTITY</span>
                    <span>{completed} OF 3 COMPLETE</span>
                  </div>
                  <section className="card resume-card">
                    <div className="card-heading">
                      <span className="step-icon">
                        <FileText size={21} />
                      </span>
                      <div>
                        <h2>Your experience, in context</h2>
                        <p>Give your interview a starting point.</p>
                      </div>
                      <span
                        className={
                          steps[0] ? "step-number done" : "step-number"
                        }
                      >
                        {steps[0] ? <Check size={15} /> : "01"}
                      </span>
                    </div>
                    <label className="upload-zone">
                      <input
                        type="file"
                        accept=".pdf,.txt,.md"
                        aria-label="Upload resume"
                        disabled={Boolean(busy) || sessionActive}
                        onChange={(e) => {
                          void importResume(e.target.files?.[0]);
                          e.target.value = "";
                        }}
                      />
                      <span className="upload-icon">
                        <Upload size={21} />
                      </span>
                      <strong>{resumeName || "Drop your resume here"}</strong>
                      <span>
                        or <u>browse files</u> to get started
                      </span>
                      <small>
                        PDF, TXT, MD · Up to 10 MB · Text extraction on device
                      </small>
                    </label>
                    <details
                      className="resume-details"
                      open={Boolean(profile.resume)}
                    >
                      <summary>
                        {profile.resume
                          ? "Review extracted resume"
                          : "Or paste your resume text"}
                        <ChevronRight size={14} />
                      </summary>
                      <label className="sr-only" htmlFor="resume-text">
                        Resume text
                      </label>
                      <textarea
                        id="resume-text"
                        value={profile.resume}
                        maxLength={MAX_RESUME_LENGTH}
                        disabled={sessionActive}
                        onChange={(e) =>
                          setProfile((p) => ({ ...p, resume: e.target.value }))
                        }
                        placeholder="Paste the experience, skills, and education you want to practice discussing."
                      />
                      <small>
                        {profile.resume.length.toLocaleString()} / 24,000
                        characters · Scanned PDFs need pasted text
                      </small>
                    </details>
                    <div className="field-row">
                      <label>
                        Your name
                        <input
                          value={profile.name}
                          maxLength={80}
                          disabled={sessionActive}
                          onChange={(e) =>
                            setProfile((p) => ({ ...p, name: e.target.value }))
                          }
                          placeholder="e.g. Alex Morgan"
                        />
                      </label>
                      <label>
                        Target role <span className="required">*</span>
                        <input
                          value={profile.role}
                          maxLength={160}
                          disabled={sessionActive}
                          onChange={(e) =>
                            setProfile((p) => ({ ...p, role: e.target.value }))
                          }
                          placeholder="e.g. Product designer"
                        />
                      </label>
                    </div>
                  </section>
                  <div className="identity-cards">
                    <section className="card compact-card">
                      <div className="card-heading">
                        <span className="step-icon peach">
                          <UserRound size={20} />
                        </span>
                        <span
                          className={
                            steps[1] ? "step-number done" : "step-number"
                          }
                        >
                          {steps[1] ? <Check size={15} /> : "02"}
                        </span>
                      </div>
                      <h2>Your identity reference</h2>
                      <p>
                        Add your photo for your
                        <br />
                        profile. Set up moving video in Video replica.
                      </p>
                      <label className="secondary-button file-button">
                        <Plus size={15} />
                        {portrait ? "Change photo" : "Add your photo"}
                        <input
                          type="file"
                          aria-label="Add your photo"
                          accept="image/png,image/jpeg,image/webp"
                          disabled={Boolean(busy)}
                          onChange={(e) => {
                            void importPortrait(e.target.files?.[0]);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      <small>JPG, PNG, WebP · Max 5 MB</small>
                    </section>
                    <section className="card compact-card">
                      <div className="card-heading">
                        <span className="step-icon lavender">
                          <Mic size={20} />
                        </span>
                        <span
                          className={
                            steps[2] ? "step-number done" : "step-number"
                          }
                        >
                          {steps[2] ? <Check size={15} /> : "03"}
                        </span>
                      </div>
                      <h2>Make it sound like you</h2>
                      <p>
                        Create a voice preview with
                        <br />
                        your own consented recording.
                      </p>
                      <button
                        className="secondary-button"
                        onClick={() => setTab("settings")}
                      >
                        <AudioLines size={15} />
                        {voiceId ? "Manage your voice" : "Set up your voice"}
                      </button>
                      <small>Powered by ElevenLabs · Optional</small>
                    </section>
                  </div>
                </div>
                <aside className="preview-column">
                  <div className="section-label">
                    <span>YOUR DIGITAL PRESENCE</span>
                    <span className="live-label">
                      <span />
                      PREVIEW
                    </span>
                  </div>
                  <section className="avatar-card">
                    <div className="avatar-top">
                      <span>
                        <Fingerprint size={14} /> YOUR IDENTITY
                      </span>
                      <span className="avatar-tag">PRIVATE</span>
                    </div>
                    <div className="orbital orbital-one" />
                    <div className="orbital orbital-two" />
                    <div className="avatar-frame">
                      {portrait ? (
                        <img
                          src={portrait}
                          alt="Your personal AI representative"
                        />
                      ) : (
                        <div className="avatar-placeholder">
                          <UserRound size={78} strokeWidth={1} />
                          <span>YOUR STORY STARTS HERE</span>
                        </div>
                      )}
                    </div>
                    <div className="avatar-info">
                      <span className="ai-badge">
                        <Sparkles size={12} /> AI-ASSISTED AVATAR
                      </span>
                      <h3>{profile.name || "Uniquely you."}</h3>
                      <p>{profile.role || "Your next opportunity awaits."}</p>
                    </div>
                    <div
                      className={speaking ? "waveform playing" : "waveform"}
                      aria-hidden="true"
                    >
                      {Array.from({ length: 39 }, (_, i) => (
                        <i
                          key={i}
                          style={{
                            height: `${8 + ((i * 17 + 13) % 33)}px`,
                            animationDelay: `${i * 0.045}s`,
                          }}
                        />
                      ))}
                    </div>
                    <button
                      className="voice-preview"
                      disabled={!voiceId || Boolean(busy)}
                      onClick={() => {
                        if (speaking) {
                          stopVoice();
                          setSpeaking(false);
                        } else void previewVoice();
                      }}
                    >
                      {speaking ? <Square size={14} /> : <Volume2 size={16} />}{" "}
                      {speaking
                        ? "Stop preview"
                        : voiceId
                          ? "Preview your voice"
                          : "Your voice will appear here"}
                    </button>
                  </section>
                  <div className="disclosure">
                    <ShieldCheck size={17} />
                    <p>
                      <strong>Confidence, with transparency.</strong>Your avatar
                      is clearly labeled as AI-assisted. Use it where the
                      interviewer explicitly permits AI participation, or in the
                      optional practice room.
                    </p>
                  </div>
                </aside>
              </div>
              <section className="launch-card">
                <span className="launch-icon">
                  <Sparkles size={23} />
                </span>
                <div>
                  <h2>Ready to meet your next opportunity?</h2>
                  <p>Your AI representative. Your experience. Your terms.</p>
                </div>
                <button
                  className="primary-button"
                  disabled={
                    Boolean(busy) ||
                    !profile.resume.trim() ||
                    !profile.role.trim()
                  }
                  onClick={() => {
                    setTab("delegate");
                  }}
                >
                  Launch interview delegate <ArrowRight size={17} />
                </button>
              </section>
              <footer>
                <span>
                  <ShieldCheck size={13} /> Built around your privacy
                </span>
                <span>YOUR AMBITION. AMPLIFIED.</span>
                <span>I / Interview · v0.2 development</span>
              </footer>
            </>
          )}
          {tab === "practice" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    <span /> A SPACE TO GET BETTER
                  </div>
                  <h1>Practice with purpose.</h1>
                  <p>
                    Five questions. Your real experience. Room to find the right
                    words.
                  </p>
                </div>
                <Headphones size={44} strokeWidth={1} />
              </div>
              {!messages.length ? (
                <section className="card practice-intro">
                  <span className="step-icon">
                    <Headphones size={28} />
                  </span>
                  <h2>Your next great conversation starts here.</h2>
                  <p>
                    Practice behavioral questions at your own pace. A portrait
                    and cloned voice are optional; your experience is what
                    matters.
                  </p>
                  <div className="mode-picker">
                    <button
                      className={
                        sessionMode === "local" ? "mode selected" : "mode"
                      }
                      onClick={() => setSessionMode("local")}
                    >
                      <ShieldCheck size={20} />
                      <strong>Local practice</strong>
                      <small>
                        Guided questions and a structure checklist. No API key.
                        No uploads.
                      </small>
                    </button>
                    <button
                      className={
                        sessionMode === "ai" ? "mode selected" : "mode"
                      }
                      onClick={() => setSessionMode("ai")}
                    >
                      <Sparkles size={20} />
                      <strong>AI coaching</strong>
                      <small>
                        Role-specific questions and feedback. Bring your
                        preferred provider.
                      </small>
                    </button>
                  </div>
                  {sessionMode === "ai" && (
                    <ModelControls config={config} setConfig={setConfig} />
                  )}
                  {sessionMode === "ai" && (
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={shareResume}
                        onChange={(e) => setShareResume(e.target.checked)}
                      />
                      I agree to send my resume, role, and session answers to
                      the selected provider for coaching. Provider charges and
                      retention policies apply.
                    </label>
                  )}
                  {(!profile.resume || !profile.role) && (
                    <p className="inline-hint">
                      Add your resume and target role in{" "}
                      <button
                        className="text-button"
                        onClick={() => setTab("studio")}
                      >
                        Identity studio
                      </button>{" "}
                      first.
                    </p>
                  )}
                  <button
                    className="primary-button"
                    disabled={Boolean(busy)}
                    onClick={() => void startSession()}
                  >
                    <Play size={16} />
                    Start a practice interview
                  </button>
                </section>
              ) : (
                <section className="card session-card">
                  <div className="session-heading">
                    <div>
                      <span className="eyebrow">
                        {sessionMode === "ai"
                          ? "AI COACHING"
                          : "LOCAL PRACTICE"}
                      </span>
                      <h2>{profile.role}</h2>
                      <small>
                        {Math.min(
                          messages.filter((m) => m.role === "candidate")
                            .length + (feedback ? 0 : 1),
                          5,
                        )}{" "}
                        / 5 questions{feedback ? " · Complete" : ""}
                      </small>
                    </div>
                    <div className="session-actions">
                      <button
                        className="secondary-button"
                        onClick={exportSession}
                      >
                        <ArrowDownToLine size={15} />
                        Export
                      </button>
                      <button
                        className="icon-button"
                        aria-label="End session and start over"
                        disabled={Boolean(busy)}
                        onClick={() => {
                          if (
                            window.confirm(
                              "End this session? Export it first if you want to keep a copy.",
                            )
                          ) {
                            setMessages([]);
                            setFeedback(null);
                            setAnswer("");
                          }
                        }}
                      >
                        <X size={18} />
                      </button>
                    </div>
                  </div>
                  <div
                    className="conversation"
                    aria-label="Interview conversation"
                  >
                    {messages.map((m, i) => (
                      <article key={i} className={`message ${m.role}`}>
                        <span className="message-avatar">
                          {m.role === "interviewer" ? (
                            <AudioLines size={18} />
                          ) : (
                            <UserRound size={18} />
                          )}
                        </span>
                        <div>
                          <strong>
                            {m.role === "interviewer"
                              ? sessionMode === "ai"
                                ? "AI interview coach"
                                : "Practice guide"
                              : profile.name || "You"}
                          </strong>
                          <p>{m.content}</p>
                        </div>
                      </article>
                    ))}
                    <div ref={endRef} />
                  </div>
                  {feedback ? (
                    <div className="feedback">
                      <div className="eyebrow">
                        <Check size={14} /> SESSION COMPLETE
                      </div>
                      <h3>A little more prepared.</h3>
                      <p>{feedback.summary}</p>
                      <h4>What you did well</h4>
                      <ul>
                        {feedback.strengths.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                      <h4>For your next round</h4>
                      <ul>
                        {feedback.improvements.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                      <button
                        className="primary-button"
                        onClick={exportSession}
                      >
                        <ArrowDownToLine size={16} />
                        Save this session
                      </button>
                    </div>
                  ) : (
                    <form
                      className="answer-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void submitAnswer();
                      }}
                    >
                      <label htmlFor="answer">Your answer</label>
                      <textarea
                        id="answer"
                        value={answer}
                        onChange={(e) => setAnswer(e.target.value)}
                        maxLength={MAX_ANSWER_LENGTH}
                        disabled={Boolean(busy)}
                        placeholder="Set the scene, share what you did, and explain the outcome…"
                        required
                      />
                      <div>
                        <small>
                          {answer.length.toLocaleString()} /{" "}
                          {MAX_ANSWER_LENGTH.toLocaleString()} · Take your time.
                        </small>
                        <button
                          className="primary-button"
                          disabled={Boolean(busy) || !answer.trim()}
                          type="submit"
                        >
                          {busy ? (
                            <LoaderCircle className="spin" size={16} />
                          ) : (
                            <>
                              Submit answer <ArrowRight size={16} />
                            </>
                          )}
                        </button>
                      </div>
                    </form>
                  )}
                </section>
              )}
            </>
          )}
          {tab === "settings" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    <span /> ON YOUR TERMS
                  </div>
                  <h1>Your connections.</h1>
                  <p>
                    Bring your own providers. Stay in control of what you share.
                  </p>
                </div>
                <Settings2 size={42} strokeWidth={1} />
              </div>
              {!desktop && (
                <div className="alert notice">
                  You’re in browser preview. Local practice and resume import
                  work here. Launch the Electron desktop app for secure provider
                  connections and voice cloning.
                </div>
              )}
              <div className="settings-grid">
                <ProviderConnections
                  onChanged={async () =>
                    setConnections(await connectionStatus())
                  }
                />

                <section className="card settings-card">
                  <h2>Your own voice</h2>
                  <p>
                    Upload a clean recording of yourself. Creation sends audio
                    to ElevenLabs and can require a paid plan or provider
                    verification. A photo does not generate a cloned voice.
                  </p>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => {
                        setConsent(e.target.checked);
                        if (!e.target.checked) {
                          stopVoice();
                          setSpeaking(false);
                        }
                      }}
                    />
                    This is my own voice. I consent to creating an AI voice with
                    ElevenLabs, and will disclose generated audio.
                  </label>
                  <label className="audio-upload">
                    Voice recording
                    <input
                      type="file"
                      accept="audio/mpeg,audio/wav,audio/mp4,audio/webm,audio/ogg"
                      disabled={!desktop || Boolean(busy)}
                      onChange={(e) =>
                        setVoiceFile(e.target.files?.[0] || null)
                      }
                    />
                  </label>
                  <small>MP3, WAV, M4A, WebM, OGG · 1 KB–10 MB</small>
                  <button
                    className="primary-button"
                    disabled={
                      !desktop ||
                      !connections.elevenlabs ||
                      !voiceFile ||
                      !consent ||
                      Boolean(busy) ||
                      Boolean(voiceId)
                    }
                    onClick={() =>
                      void run("Creating your voice", async () => {
                        const created = await cloneVoice(
                          profile.name || "My interview voice",
                          voiceFile!,
                        );
                        setVoiceId(created.id);
                        setVoiceFile(null);
                        setNotice(
                          created.verificationRequired
                            ? "Voice created; ElevenLabs requires verification before synthesis. Complete verification with the provider."
                            : "Voice created. Preview it in Identity studio. Your provider retains the voice until you delete it.",
                        );
                      })
                    }
                  >
                    <Mic size={15} />
                    {voiceId
                      ? "Voice created for this session"
                      : "Create my voice"}
                  </button>
                  {voiceId && (
                    <button
                      className="text-button danger"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run("Deleting provider voice", async () => {
                          await bridge().deleteVoice(voiceId);
                          stopVoice();
                          setSpeaking(false);
                          setVoiceId("");
                          setNotice("Voice deleted from ElevenLabs.");
                        })
                      }
                    >
                      Delete this voice from ElevenLabs
                    </button>
                  )}
                  <p className="inline-hint">
                    The delegate can answer and speak on your behalf in its
                    interview room. Use Video replica for the self-hosted
                    moving-face pipeline; this panel manages the optional
                    ElevenLabs voice.
                  </p>
                </section>
              </div>
              <Updates />
              <section className="card privacy-settings">
                <ShieldCheck size={24} />
                <div>
                  <h2>Private until you decide otherwise.</h2>
                  <p>
                    Your resume, portrait, transcript, and voice reference stay
                    in application memory. Closing the app clears them; export a
                    session to keep it. Provider-stored voices persist
                    separately: delete a created voice here before clearing, or
                    manage it in ElevenLabs. AI delegation and coaching send
                    your resume and session only after you opt in. Prepared
                    video caches and local voice references persist on your
                    engine machine; clearing this workspace does not delete
                    them. No analytics or automatic recording.
                  </p>
                  <button
                    className="secondary-button"
                    disabled={Boolean(busy) || delegateBusy}
                    onClick={clearWorkspace}
                  >
                    <Trash2 size={15} />
                    Clear local workspace
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
