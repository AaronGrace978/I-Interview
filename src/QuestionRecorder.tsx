import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";
import { bridge, desktop } from "./platform";

export default function QuestionRecorder({
  disabled,
  onQuestion,
  reportBusy,
}: {
  disabled: boolean;
  onQuestion: (text: string) => void;
  reportBusy: (busy: boolean) => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const [acquiring, setAcquiring] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);
  const stopped = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stopped.current = true;
      if (timer.current) clearInterval(timer.current);
      recorder.current?.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      reportBusy(false);
    };
  }, [reportBusy]);
  function finish() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }
  async function start() {
    if (!agreed || disabled || acquiring || !desktop) return;
    setAcquiring(true);
    reportBusy(true);
    setError("");
    setElapsed(0);
    stopped.current = false;
    try {
      if (typeof MediaRecorder === "undefined")
        throw new Error(
          "Microphone capture is unsupported on this device. Type the question instead.",
        );
      const mime = [
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mime)
        throw new Error(
          "Audio recording is unsupported on this device. Type the question instead.",
        );
      const capture = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (!alive.current) {
        capture.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = capture;
      const rec = new MediaRecorder(capture, {
        mimeType: mime,
        audioBitsPerSecond: 64000,
      });
      recorder.current = rec;
      const chunks: Blob[] = [];
      let size = 0;
      const started = performance.now();
      rec.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          size += event.data.size;
          if (size > 10 * 1024 * 1024) finish();
        }
      };
      rec.onerror = () => {
        stopped.current = true;
        finish();
        if (alive.current)
          setError("Microphone recording failed. Type your question instead.");
      };
      rec.onstop = async () => {
        capture.getTracks().forEach((track) => track.stop());
        stream.current = null;
        recorder.current = null;
        if (timer.current) clearInterval(timer.current);
        if (!alive.current) return;
        setRecording(false);
        if (stopped.current) {
          reportBusy(false);
          return;
        }
        if (size > 10 * 1024 * 1024 || size < 128) {
          setError("Recording was empty or too large. Try a shorter question.");
          reportBusy(false);
          return;
        }
        setTranscribing(true);
        try {
          const audio = new Uint8Array(
            await new Blob(chunks, { type: mime }).arrayBuffer(),
          );
          const text = await bridge().transcribe(
            audio,
            mime.split(";")[0],
            true,
          );
          if (alive.current) onQuestion(text);
        } catch (e) {
          if (alive.current)
            setError(e instanceof Error ? e.message : "Transcription failed.");
        } finally {
          if (alive.current) {
            setTranscribing(false);
            reportBusy(false);
          }
        }
      };
      rec.start(250);
      setRecording(true);
      reportBusy(true);
      timer.current = setInterval(() => {
        setElapsed(Math.floor((performance.now() - started) / 1000));
        if (performance.now() - started >= 60_000) finish();
      }, 250);
    } catch (e) {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      reportBusy(false);
      setError(e instanceof Error ? e.message : "Microphone access failed.");
    } finally {
      if (alive.current) setAcquiring(false);
    }
  }
  return (
    <div className="question-recorder">
      <label className="check-label">
        <input
          type="checkbox"
          checked={agreed}
          disabled={disabled || acquiring || recording || transcribing}
          onChange={(e) => setAgreed(e.target.checked)}
        />
        The speaker consents to recording and sending this question to OpenAI
        for transcription. Requires an OpenAI connection, regardless of the
        answer provider.
      </label>
      <div>
        {recording ? (
          <>
            <span className="recording-indicator">
              ● Recording · {elapsed}s / 60s
            </span>
            <button
              type="button"
              className="stop-button"
              onClick={(e) => {
                e.preventDefault();
                finish();
              }}
            >
              <Square size={12} />
              Stop and transcribe
            </button>
          </>
        ) : (
          <button
            type="button"
            className="secondary-button"
            disabled={
              disabled || acquiring || !desktop || !agreed || transcribing
            }
            onClick={() => void start()}
          >
            {transcribing ? (
              <LoaderCircle size={13} className="spin" />
            ) : (
              <Mic size={13} />
            )}{" "}
            {transcribing
              ? "Transcribing question…"
              : "Record interviewer’s question"}
          </button>
        )}
      </div>
      <small>
        Microphone capture is visible and limited to 60 seconds. Review the
        transcript, then choose “Answer on my behalf.”
      </small>
      {error && (
        <p className="model-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
