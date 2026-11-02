import { ArrowRight, BookOpen } from "lucide-react";

type Destination = "studio" | "replica" | "delegate" | "practice" | "settings";

export default function Guide({
  onOpen,
}: {
  onOpen: (tab: Destination) => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span /> START HERE
          </div>
          <h1>How to get started.</h1>
          <p>
            The app has three jobs. Set up your resume first. Add a provider
            key when you want the AI to speak. The moving face is a separate
            local GPU setup and stays blank until real frames arrive.
          </p>
        </div>
        <BookOpen size={40} strokeWidth={1} />
      </div>
      <div className="guide-stack">
        <section className="card guide-card">
          <h2>What each screen does</h2>
          <ul>
            <li>
              <strong>Identity studio</strong> holds your name, target role,
              and resume. The photo here is a still portrait. It never becomes
              the moving video.
            </li>
            <li>
              <strong>Interview delegate</strong> answers an interviewer’s
              question from that resume. You have to tell the interviewer it
              is an AI.
            </li>
            <li>
              <strong>Practice room</strong> is you answering five questions.
              Local practice needs no API key.
            </li>
            <li>
              <strong>Video replica</strong> plays a lip-synced video of you
              from footage you prepare on this PC’s GPU.
            </li>
            <li>
              <strong>Connections</strong> is where provider keys are saved.
              Windows encrypts them. Resume text and the conversation live
              only in this window.
            </li>
          </ul>
        </section>

        <section className="card guide-card">
          <h2>1. Put your experience in</h2>
          <ol>
            <li>
              Open Identity studio. Drop a PDF, TXT, or Markdown resume on the
              upload box, or paste the text. A scanned, image-only PDF will
              not extract. Paste the words instead.
            </li>
            <li>Fill in Your name and Target role. Both are required.</li>
            <li>A photo is optional. Skip it if you only want written answers.</li>
          </ol>
          <div className="guide-actions">
            <button className="secondary-button" onClick={() => onOpen("studio")}>
              Open Identity studio <ArrowRight size={14} />
            </button>
          </div>
        </section>

        <section className="card guide-card">
          <h2>2. Connect a model</h2>
          <ol>
            <li>
              Open Connections. Pick OpenAI, Anthropic, OpenRouter, xAI, or
              Ollama Cloud.
            </li>
            <li>
              Paste that provider’s API key and save it. The delegate cannot
              write an answer without one. ElevenLabs is only for a cloned
              voice, and it is optional.
            </li>
            <li>
              Open Interview delegate. Refresh models and pick a text model,
              or type an exact model ID.
            </li>
            <li>
              Add extra facts only if you are willing to have them said. Check
              the disclosure box. The answer button stays off until that box
              is checked and a model is selected.
            </li>
            <li>
              Type the interviewer’s question and click Answer on my behalf.
              Read the answer before anyone hears it. Export saves the
              transcript as JSON. Closing the app clears the conversation.
            </li>
          </ol>
          <p>
            For written answers, set Answer output to Audio only, or leave
            automatic speech off. Automatic speech with the video replica
            stays blocked until the preview says it is receiving real frames.
          </p>
          <div className="guide-actions">
            <button
              className="secondary-button"
              onClick={() => onOpen("settings")}
            >
              Open Connections <ArrowRight size={14} />
            </button>
            <button
              className="secondary-button"
              onClick={() => onOpen("delegate")}
            >
              Open Interview delegate <ArrowRight size={14} />
            </button>
            <button
              className="secondary-button"
              onClick={() => onOpen("practice")}
            >
              Open Practice room <ArrowRight size={14} />
            </button>
          </div>
        </section>

        <section className="card guide-card">
          <h2>3. Turn on the moving video</h2>
          <p>
            This path runs in Ubuntu under WSL2 and uses the NVIDIA GPU. This
            PC is an ASUS TUF GAMING X570-PLUS with a Ryzen 7 3700X and an RTX
            5060 Ti. If Check engine already says the engine is configured and
            the CUDA line names that GPU, skip to “Prepare your face” below.
          </p>
          <h3>Turn on virtualization once</h3>
          <ol>
            <li>Restart and press Delete to open the ASUS BIOS.</li>
            <li>Press F7 for Advanced Mode.</li>
            <li>
              Open Advanced, then CPU Configuration, then SVM Mode, and set it
              to Enabled.
            </li>
            <li>Press F10 and let Windows boot.</li>
          </ol>
          <p>
            Windows will not start Ubuntu until SVM is enabled.{" "}
            <code>wsl -d Ubuntu-24.04</code> should open a shell afterward.
          </p>
          <h3>Install the engine inside Ubuntu</h3>
          <ol>
            <li>
              Install the tools the setup script checks for:{" "}
              <code>python3.12</code>, <code>python3.12-venv</code>,{" "}
              <code>python3.12-dev</code>, <code>git</code>, <code>ffmpeg</code>
              , <code>build-essential</code>, <code>cmake</code>, and{" "}
              <code>libsndfile1</code>.
            </li>
            <li>
              Install uv from the official Astral installer, then from this
              repository run <code>python3.12 avatar-engine/setup_local.py</code>
              . <code>nvidia-smi</code> must list the RTX 5060 Ti. If the
              script says nvidia-smi is missing, put{" "}
              <code>/usr/lib/wsl/lib</code> on PATH and run it again.
            </li>
            <li>
              Leave two Ubuntu terminals running, both from this repository:
            </li>
          </ol>
          <pre className="guide-code">{`~/.i-interview-avatar/gateway-env/bin/python avatar-engine/server.py
~/.i-interview-avatar/voice-env/bin/python avatar-engine/voice_server.py`}</pre>
          <h3>Paste the token once</h3>
          <ol>
            <li>
              The gateway writes a secret to{" "}
              <code>~/.i-interview-avatar/engine-token</code> the first time it
              starts. That file is the token. The gray text under the box is
              the path, not an example password.
            </li>
            <li>
              Paste the file’s contents into Local engine token and click Save
              engine connection. It has to be at least 32 characters. A
              password you make up will not connect.
            </li>
            <li>
              Click Check engine, then Validate CUDA kernels. A good result
              names the RTX 5060 Ti and says the kernel check passed. After
              the token is saved, the box can stay empty.
            </li>
          </ol>
          <h3>Prepare your face, then start it</h3>
          <ol>
            <li>
              Check the consent box. Pick a replica ID, such as your first
              name. Click Choose my footage and prepare and select a short,
              well-lit video of your own face.
            </li>
            <li>
              Wait until the status says Preparation: completed. The first run
              scans every frame and can take several minutes. The preview stays
              on Not connected the whole time.
            </li>
            <li>
              If you see “That avatar ID already exists,” the replica is
              already built. Do not prepare it again. Choose that ID under
              Prepared replica.
            </li>
            <li>
              Click Start my video replica. Wait until the corner says
              Receiving real video frames. That is the first moment your
              moving face appears.
            </li>
            <li>
              Then go to Interview delegate, leave Answer output on My
              self-hosted video replica, and turn on automatic speech if you
              want the mouth to follow the answer.
            </li>
          </ol>
          <div className="guide-actions">
            <button
              className="secondary-button"
              onClick={() => onOpen("replica")}
            >
              Open Video replica <ArrowRight size={14} />
            </button>
          </div>
        </section>
      </div>
    </>
  );
}
