import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  Clock3,
  ShieldCheck,
  Square,
  Volume2,
} from "lucide-react";
import type { Profile, Message } from "./domain";
import {
  desktop,
  generateText,
  playVoice,
  stopVoice,
  type ModelConfig,
} from "./platform";
import { ModelControls } from "./Connections";
import QuestionRecorder from "./QuestionRecorder";

export default function Delegate({
  profile,
  portrait,
  voiceId,
  consent,
  config,
  setConfig,
  reportBusy,
}: {
  profile: Profile;
  portrait: string;
  voiceId: string;
  consent: boolean;
  config: ModelConfig;
  setConfig: (c: ModelConfig) => void;
  reportBusy: (busy: boolean) => void;
}) {
  const [sessionProfile, setSessionProfile] = useState<Profile | null>(null);
  const [sessionConfig, setSessionConfig] = useState<ModelConfig | null>(null);
  const represented = sessionProfile ?? profile;
  const selected = sessionConfig ?? config;
  const [facts, setFacts] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  useEffect(() => {
    reportBusy(busy || speaking || micBusy);
  }, [busy, speaking, micBusy, reportBusy]);
  const [error, setError] = useState("");
  const [timing, setTiming] = useState<{
    firstTokenMs: number;
    totalMs: number;
  } | null>(null);
  const [audioLatency, setAudioLatency] = useState<number | null>(null);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const round = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      round.current++;
      controller.current?.abort();
      stopVoice();
      reportBusy(false);
    };
  }, [reportBusy]);
  function stop() {
    round.current++;
    controller.current?.abort();
    controller.current = null;
    stopVoice();
    setSpeaking(false);
    setBusy(false);
    reportBusy(false);
  }
  async function ask() {
    if (busy || micBusy || !question.trim()) return;
    if (!agreed) {
      setError(
        "Confirm disclosure, interviewer permission, and provider sharing before starting.",
      );
      return;
    }
    if (
      !represented.resume.trim() ||
      !represented.role.trim() ||
      !selected.model.trim()
    ) {
      setError("Add your resume, role, provider, and exact model ID first.");
      return;
    }
    if (messages.length >= 38) {
      setError(
        "This session has reached 19 turns. Export and start a new session.",
      );
      return;
    }
    const current = ++round.current;
    const active = () => alive.current && current === round.current;
    const updated: Message[] = [
      ...messages,
      { role: "interviewer", content: question.trim() },
    ];
    setBusy(true);
    reportBusy(true);
    setError("");
    setDraft("");
    setTiming(null);
    setAudioLatency(null);
    const abort = new AbortController();
    controller.current = abort;
    let speechBuffer = "";
    let speechChain = Promise.resolve();
    let speechFailed = false;
    const started = performance.now();
    function queueSpeech(text: string) {
      if (!autoSpeak || !voiceId || !consent || !text.trim()) return;
      speechChain = speechChain.then(async () => {
        if (!active() || speechFailed) return;
        setSpeaking(true);
        try {
          await playVoice(voiceId, text, () => {
            if (active())
              setAudioLatency(
                (prev) => prev ?? Math.round(performance.now() - started),
              );
          });
        } catch (e) {
          speechFailed = true;
          if (active())
            setError(
              e instanceof Error
                ? e.message
                : "Speech failed. Text answers remain available.",
            );
        }
      });
    }
    try {
      const result = await generateText(
        {
          ...selected,
          profile: represented,
          facts,
          messages: updated,
          mode: "delegate",
        },
        (token) => {
          if (!active()) return;
          setDraft((prev) => prev + token);
          // Queue complete sentences while the model is still generating. This
          // overlaps LLM and speech latency without parallel, overlapping audio.
          speechBuffer += token;
          if (speechBuffer.length >= 80) {
            const boundary = speechBuffer.search(/[.!?](?:\s|$)/);
            if (boundary >= 0) {
              queueSpeech(speechBuffer.slice(0, boundary + 1));
              speechBuffer = speechBuffer.slice(boundary + 1);
            }
          }
        },
        abort.signal,
      );
      if (!active()) return;
      queueSpeech(speechBuffer);
      setSessionProfile(represented);
      setSessionConfig(selected);
      setTiming(result);
      setMessages([...updated, { role: "candidate", content: result.text }]);
      setDraft("");
      setQuestion("");
      await speechChain;
    } catch (e) {
      if (active()) {
        stopVoice();
        setError(e instanceof Error ? e.message : "Response failed.");
      }
    } finally {
      if (active()) {
        controller.current = null;
        setBusy(false);
        setSpeaking(false);
        reportBusy(false);
      }
    }
  }
  async function speak(text: string) {
    if (!consent || !voiceId || !agreed) return;
    setSpeaking(true);
    setError("");
    const current = ++round.current;
    try {
      await playVoice(voiceId, text, (ms) => {
        if (current === round.current) setAudioLatency(ms);
      });
    } catch (e) {
      if (alive.current && current === round.current)
        setError(e instanceof Error ? e.message : "Speech failed.");
    } finally {
      if (alive.current && current === round.current) setSpeaking(false);
    }
  }
  function download() {
    const json = JSON.stringify(
      {
        version: 1,
        mode: "disclosed-ai-delegate",
        candidate: represented.name,
        role: represented.role,
        provider: selected.provider,
        model: selected.model,
        disclosure:
          "I am an AI representative answering from the candidate’s approved experience.",
        messages,
        latency: timing,
        firstAudioMs: audioLatency,
        exportedAt: new Date().toISOString(),
      },
      null,
      2,
    );
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "i-interview-delegate.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span /> YOUR EXPERIENCE, REPRESENTED
          </div>
          <h1>Let your story answer.</h1>
          <p>
            Your AI delegate answers on your behalf, grounded in the experience
            you approve.
          </p>
        </div>
        <span className="edition-label">
          THE INTERVIEW ROOM<span>02 / REPRESENT</span>
        </span>
      </div>
      <div className="delegate-grid">
        <div>
          <section className="card delegate-config">
            <div className="card-heading">
              <span className="step-icon">
                <AudioLines size={20} />
              </span>
              <div>
                <h2>Your AI representative</h2>
                <p>Choose the intelligence behind your voice.</p>
              </div>
            </div>
            <ModelControls
              config={selected}
              setConfig={setConfig}
              disabled={busy || messages.length > 0}
            />
            <label className="facts-label">
              Additional approved facts
              <textarea
                aria-label="Additional approved facts"
                value={facts}
                maxLength={12000}
                disabled={busy || messages.length > 0}
                onChange={(e) => setFacts(e.target.value)}
                placeholder="Availability, relevant achievements, boundaries, and details your resume leaves out. Only add facts the delegate may share."
              />
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={agreed}
                disabled={busy}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              The interviewer knows this is an AI representative and permits it.
              I approve sending my resume, approved facts, and this conversation
              to the selected provider.
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={autoSpeak}
                disabled={!voiceId || !consent || busy}
                onChange={(e) => setAutoSpeak(e.target.checked)}
              />
              Speak answers automatically in my consented voice. Answer text is
              sent to ElevenLabs. Audio starts sentence by sentence.
            </label>
            <p className="inline-hint">
              A model can still make mistakes. Review approved facts and
              supervise answers. No fabricated experience, silent provider
              fallback, or hidden participation.
            </p>
          </section>
          <section className="card session-card delegate-session">
            <div className="session-heading">
              <div>
                <span className="eyebrow">INTERVIEW CONVERSATION</span>
                <h2>{represented.role || "Your interview"}</h2>
              </div>
              <button
                className="secondary-button"
                disabled={!messages.length}
                onClick={download}
              >
                <ArrowDownToLine size={14} />
                Export
              </button>
            </div>
            <div className="delegate-disclosure">
              <ShieldCheck size={15} />
              <span>
                I am an AI representative answering from{" "}
                {represented.name || "the candidate"}’s approved experience.
              </span>
            </div>
            <div className="conversation">
              {!messages.length && !draft && (
                <div className="empty-conversation">
                  <AudioLines size={30} />
                  <h3>Ready when the conversation is.</h3>
                  <p>
                    Enter an interviewer’s question below. Your delegate will
                    respond from your resume and approved facts.
                  </p>
                </div>
              )}
              {messages.map((m, i) => (
                <article key={i} className={`message ${m.role}`}>
                  <span className="message-avatar">
                    {m.role === "interviewer" ? "?" : <AudioLines size={17} />}
                  </span>
                  <div>
                    <strong>
                      {m.role === "interviewer"
                        ? "Interviewer"
                        : `${represented.name || "Candidate"}’s AI representative`}
                    </strong>
                    <p>{m.content}</p>
                    {m.role === "candidate" && voiceId && (
                      <button
                        className="text-button"
                        disabled={busy || speaking || !consent || !agreed}
                        onClick={() => void speak(m.content)}
                      >
                        <Volume2 size={12} /> Speak answer
                      </button>
                    )}
                  </div>
                </article>
              ))}
              {draft && (
                <article className="message candidate">
                  <span className="message-avatar">
                    <AudioLines size={17} />
                  </span>
                  <div>
                    <strong>
                      AI representative ·{" "}
                      {busy
                        ? "Answering"
                        : "Interrupted draft, not sent to history"}
                    </strong>
                    <p>
                      {draft}
                      <span className={busy ? "typing-caret" : ""} />
                    </p>
                  </div>
                </article>
              )}
            </div>
            {error && (
              <div className="alert error delegate-error" role="alert">
                {error}
              </div>
            )}
            <form
              className="answer-form"
              onSubmit={(e) => {
                e.preventDefault();
                void ask();
              }}
            >
              <label htmlFor="interviewer-question">
                Interviewer’s question
              </label>
              <textarea
                id="interviewer-question"
                value={question}
                maxLength={6000}
                disabled={busy || speaking || micBusy}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="What would you like to know about the candidate’s experience?"
              />
              <QuestionRecorder
                disabled={busy || speaking}
                onQuestion={setQuestion}
                reportBusy={setMicBusy}
              />
              <div>
                <small>
                  {question.length} / 6,000 · {messages.length / 2} turns
                </small>
                {busy || speaking ? (
                  <button
                    type="button"
                    className="stop-button"
                    onClick={(event) => {
                      event.preventDefault();
                      stop();
                    }}
                  >
                    <Square size={14} />
                    Stop now
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    disabled={
                      micBusy ||
                      !desktop ||
                      !agreed ||
                      !question.trim() ||
                      !selected.model.trim()
                    }
                    type="submit"
                  >
                    Answer on my behalf <ArrowRight size={15} />
                  </button>
                )}
              </div>
            </form>
          </section>
        </div>
        <aside className="delegate-side">
          <section className="card representative-card">
            {portrait ? (
              <img src={portrait} alt="Candidate portrait" />
            ) : (
              <div className="representative-placeholder">
                <AudioLines size={45} />
              </div>
            )}
            <span className="ai-badge">
              <ShieldCheck size={12} /> DISCLOSED AI REPRESENTATIVE
            </span>
            <h2>{represented.name || "Your representative"}</h2>
            <p>{represented.role || "Add your role in Identity studio"}</p>
            <span className="representative-status">
              <span className="status-dot" />
              {busy ? "Answering" : speaking ? "Speaking" : "Standing by"}
            </span>
          </section>
          <section className="card latency-card">
            <h2>
              <Clock3 size={16} /> Response telemetry
            </h2>
            <dl>
              <div>
                <dt>First model token</dt>
                <dd>{timing ? `${timing.firstTokenMs} ms` : "—"}</dd>
              </div>
              <div>
                <dt>Full model response</dt>
                <dd>
                  {timing ? `${(timing.totalMs / 1000).toFixed(2)} s` : "—"}
                </dd>
              </div>
              <div>
                <dt>First audible playback</dt>
                <dd>{audioLatency === null ? "—" : `${audioLatency} ms`}</dd>
              </div>
            </dl>
            <p>
              Streaming model output + sentence-level ElevenLabs Flash speech.
              Actual latency depends on your model, provider, network, and audio
              playback.
            </p>
          </section>
          <div className="disclosure">
            <ShieldCheck size={17} />
            <p>
              <strong>A representative, with boundaries.</strong>Type a question
              or record it with consent. This room does not join external calls,
              create a virtual camera, animate a photo, or route audio into
              another interview service.
            </p>
          </div>
          <button
            className="secondary-button"
            disabled={busy || speaking || !messages.length}
            onClick={() => {
              if (
                window.confirm(
                  "Clear this interview? Export it first to keep a copy.",
                )
              ) {
                setMessages([]);
                setSessionProfile(null);
                setSessionConfig(null);
                setDraft("");
                setTiming(null);
              }
            }}
          >
            Start a fresh interview
          </button>
          {!desktop && (
            <p className="inline-hint">
              Open the Electron desktop app to connect providers and run your
              delegate.
            </p>
          )}
        </aside>
      </div>
    </>
  );
}
