import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Download,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { providers, type KeyProvider, type UpdateStatus } from "./contracts";
import { bridge, desktop, type ModelConfig } from "./platform";

export function ModelControls({
  config,
  setConfig,
  disabled = false,
}: {
  config: ModelConfig;
  setConfig: (c: ModelConfig) => void;
  disabled?: boolean;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshed, setRefreshed] = useState("");
  const version = useRef(0);
  useEffect(() => {
    version.current++;
    setModels([]);
    setError("");
    setRefreshed("");
    setLoading(false);
  }, [config.provider]);
  async function refresh() {
    const current = ++version.current;
    setLoading(true);
    setError("");
    try {
      const ids = await bridge().listModels(config.provider);
      if (current === version.current) {
        setModels(ids);
        setRefreshed(
          `${ids.length} models · fetched ${new Date().toLocaleTimeString()}`,
        );
      }
    } catch (e) {
      if (current === version.current)
        setError(e instanceof Error ? e.message : "Model lookup failed.");
    } finally {
      if (current === version.current) setLoading(false);
    }
  }
  return (
    <div className="model-controls">
      <div className="model-fields">
        <label>
          AI provider
          <select
            aria-label="AI provider"
            value={config.provider}
            disabled={disabled}
            onChange={(e) =>
              setConfig({
                provider: e.target.value as ModelConfig["provider"],
                model: "",
              })
            }
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Exact model ID
          <input
            aria-label="Exact model ID"
            list={`models-${config.provider}`}
            value={config.model}
            maxLength={200}
            disabled={disabled}
            onChange={(e) => setConfig({ ...config, model: e.target.value })}
            placeholder="Refresh models or enter an ID"
          />
          <datalist id={`models-${config.provider}`}>
            {models.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </label>
        <button
          className="secondary-button"
          disabled={!desktop || loading || disabled}
          onClick={() => void refresh()}
          type="button"
        >
          {loading ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          Refresh models
        </button>
      </div>
      {models.length > 0 && (
        <label className="catalog-select">
          Browse provider catalog
          <select
            aria-label="Browse provider catalog"
            value={models.includes(config.model) ? config.model : ""}
            disabled={disabled}
            onChange={(e) => setConfig({ ...config, model: e.target.value })}
          >
            <option value="" disabled>
              Select one of {models.length} models
            </option>
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      )}
      {refreshed && (
        <small className="catalog-info">
          {refreshed}. Availability and capabilities vary by account.
        </small>
      )}
      {error && (
        <p className="model-error" role="alert">
          {error}
        </p>
      )}
      <small className="catalog-info">
        Catalogs are fetched directly from your provider. New IDs work without
        an app update. Choose a text chat model; image, embedding, audio-only,
        and incompatible models cannot answer interview questions. No automatic
        provider switching.
      </small>
    </div>
  );
}

export function ProviderConnections({
  onChanged,
}: {
  onChanged: () => Promise<void>;
}) {
  const [provider, setProvider] = useState<KeyProvider>("openai");
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<Partial<Record<KeyProvider, boolean>>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (desktop)
      void bridge()
        .credentialStatus()
        .then(setStatus)
        .catch(() => setError("Credential store is unavailable."));
  }, []);
  async function change(remove = false) {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      if (remove) await bridge().deleteCredential(provider);
      else await bridge().saveCredential(provider, key);
      setKey("");
      setStatus(await bridge().credentialStatus());
      await onChanged();
      setMessage(
        remove
          ? "Saved key removed."
          : "Key encrypted with your OS credential store.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Credential operation failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card settings-card">
      <h2>Provider connections</h2>
      <p>
        OpenAI, Anthropic, OpenRouter, xAI, Ollama Cloud, and ElevenLabs. Each
        key is encrypted by your operating system. Plaintext fallback is
        disabled. Keys never enter browser storage.
      </p>
      <div className="provider-chips">
        {[...providers, { id: "elevenlabs" as const, name: "ElevenLabs" }].map(
          (p) => (
            <button
              key={p.id}
              className={
                provider === p.id ? "provider-chip selected" : "provider-chip"
              }
              disabled={busy}
              onClick={() => {
                setProvider(p.id);
                setKey("");
                setError("");
                setMessage("");
              }}
            >
              {p.name}
              {status[p.id] && <Check size={11} />}
            </button>
          ),
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void change();
        }}
      >
        <label>
          {provider === "elevenlabs"
            ? "ElevenLabs"
            : providers.find((p) => p.id === provider)?.name}{" "}
          API key
          <span className="connection-state">
            {status[provider] ? "Saved" : "Not connected"}
          </span>
          <input
            type="password"
            aria-label="Provider API key"
            value={key}
            maxLength={512}
            autoComplete="off"
            disabled={!desktop || busy}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste your API key"
          />
        </label>
        <button
          className="primary-button"
          disabled={!desktop || busy || key.trim().length < 10}
        >
          {busy ? (
            <LoaderCircle className="spin" size={14} />
          ) : (
            <>
              Save connection <ArrowRight size={14} />
            </>
          )}
        </button>
      </form>
      {status[provider] && (
        <button
          className="text-button danger"
          disabled={busy}
          onClick={() => void change(true)}
        >
          Remove this provider’s saved key
        </button>
      )}
      {message && (
        <p className="inline-hint" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="model-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
export function Updates() {
  const [status, setStatus] = useState<UpdateStatus>({
    state: "idle",
    message: desktop
      ? "Signed Windows and macOS releases check at launch and every four hours. Updates download automatically and install on quit."
      : "Updates are available in the installed desktop app.",
  });
  const [error, setError] = useState("");
  useEffect(() => {
    if (desktop) return bridge().onUpdate(setStatus);
  }, []);
  async function act(install: boolean) {
    setError("");
    try {
      if (install) await bridge().installUpdate();
      else await bridge().checkUpdate();
    } catch {
      setError(
        "Update action failed. Check the release configuration and network.",
      );
    }
  }
  return (
    <section className="card privacy-settings">
      <Download size={24} />
      <div>
        <h2>Stay up to date.</h2>
        <p role="status">
          {status.message}
          {status.percent !== undefined
            ? ` ${Math.round(status.percent)}%`
            : ""}
        </p>
        <p>
          Save your transcript before quitting. Automatic updates require
          published, signed releases; Linux installations use manual updates.
        </p>
        <button
          className="secondary-button"
          disabled={
            !desktop || ["checking", "downloading"].includes(status.state)
          }
          onClick={() => void act(status.state === "downloaded")}
        >
          {status.state === "downloaded"
            ? "Restart and install"
            : "Check for updates"}
          <RefreshCw size={14} />
        </button>
        {error && (
          <p className="model-error" role="alert">
            {error}
          </p>
        )}
        <p className="inline-hint">
          <ShieldCheck size={12} /> Downloads use HTTPS and artifact checksums;
          Windows and macOS releases require code signing in the release
          workflow.
        </p>
      </div>
    </section>
  );
}
