import { useEffect, useRef, useState } from "react";
import {
  ArrowUp, Plus, Menu, X, MessageSquare, Code2, FileText,
  Image as ImageIcon, Sparkles, PanelLeftClose, ShieldCheck
} from "lucide-react";
import "./App.css";

const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:5000").replace(/\/$/, "");

const starterPrompts = [
  { icon: Code2, title: "Help me write code", text: "Explain a JavaScript function with a simple example." },
  { icon: FileText, title: "Understand a document", text: "How can I summarize a long PDF document?" },
  { icon: Sparkles, title: "Explore an idea", text: "Give me a practical project idea for a beginner web developer." },
  { icon: ImageIcon, title: "Create something", text: "Help me write a detailed prompt for a futuristic city illustration." }
];

function VeyroMark({ compact = false }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <div className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 40 40" role="img">
          <defs>
            <linearGradient id="veyro-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#a78bfa" />
              <stop offset="100%" stopColor="#38bdf8" />
            </linearGradient>
          </defs>
          <path d="M6 9 L15 9 L21 24 L28 9 L36 9 L23 33 L17 33 Z" fill="url(#veyro-gradient)" />
        </svg>
      </div>
      {!compact && <span className="brand-word">veyro<span className="brand-dot">.</span></span>}
    </div>
  );
}

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [apiStatus, setApiStatus] = useState("checking");
  const [availableModels, setAvailableModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState("");
  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    let active = true;
    Promise.all([fetch(`${API_URL}/api/health`), fetch(`${API_URL}/api/models`)])
      .then(async ([healthResponse, modelsResponse]) => {
        if (!healthResponse.ok || !modelsResponse.ok) throw new Error("Backend unavailable");
        return [await healthResponse.json(), await modelsResponse.json()];
      })
      .then(([health, modelData]) => {
        if (!active) return;
        setApiStatus(health.status === "ok" ? "online" : "offline");
        setAvailableModels(modelData.models || []);
        setSelectedModel(modelData.defaultModel || "");
      })
      .catch(() => { if (active) setApiStatus("offline"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  async function sendMessage(text = input) {
    const prompt = text.trim();
    if (!prompt || loading) return;

    if (!selectedModel) {
      setError("Add at least one provider API key to server/.env, then restart the API.");
      return;
    }
    const nextMessages = [...messages, { role: "user", content: prompt }];
    const withAssistantPlaceholder = [...nextMessages, { role: "assistant", content: "" }];
    setMessages(nextMessages);
    setInput("");
    setError("");
    setLoading(true);
    setSidebarOpen(false);
    let partialReply = "";

    try {
      setMessages(withAssistantPlaceholder);
      const response = await fetch(`${API_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, model: selectedModel })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Veyro could not complete that request.");
      }
      if (!response.body) throw new Error("Streaming is not available in this browser.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || "";
        for (const eventBlock of events) {
          const eventName = eventBlock.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim();
          const dataLine = eventBlock.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
          if (!dataLine) continue;
          const eventData = JSON.parse(dataLine);
          if (eventName === "token") {
            partialReply += eventData.text || "";
            setMessages([...nextMessages, { role: "assistant", content: partialReply }]);
          } else if (eventName === "error") {
            throw new Error(eventData.message || "Veyro could not complete that request.");
          } else if (eventName === "done") {
            finished = true;
          }
        }
        if (done) finished = true;
      }
      if (!partialReply) setMessages(nextMessages);
    } catch (err) {
      setMessages(partialReply ? [...nextMessages, { role: "assistant", content: partialReply }] : nextMessages);
      setError(err.message || "Could not connect to Veyro. Check that the backend is running.");
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function startNewChat() {
    setMessages([]);
    setError("");
    setInput("");
    setSidebarOpen(false);
    inputRef.current?.focus();
  }

  return (
    <div className="app-shell">
      {sidebarOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <VeyroMark />
          <button className="icon-button close-sidebar" aria-label="Close menu" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        </div>
        <button className="new-chat-button" onClick={startNewChat}>
          <Plus size={17} /> <span>New chat</span> <span className="shortcut">Ctrl K</span>
        </button>

          <div className="nav-label">WORKSPACE</div>
        <nav className="workspace-nav" aria-label="Workspace">
          <button className="nav-item active" onClick={() => setSidebarOpen(false)}><MessageSquare size={17} /><span>AI Assistant</span><span className="active-dot" /></button>
        </nav>

        <div className="sidebar-divider" />
        <div className="history-heading"><span className="nav-label">THIS SESSION</span><PanelLeftClose size={15} /></div>
        {messages.length > 0 ? (
          <div className="history-item"><MessageSquare size={15} /><span>{messages.find(m => m.role === "user")?.content || "Current conversation"}</span></div>
        ) : <p className="empty-history">Chat history is not saved yet.</p>}

        <div className="sidebar-bottom">
          <label className="model-card" htmlFor="model-select">
            <div className="model-icon"><Sparkles size={16} /></div>
            <div className="model-copy"><strong>Choose a model</strong><span>{availableModels.length ? `${availableModels.length} configured` : "No provider keys configured"}</span></div>
            <select id="model-select" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={!availableModels.length || loading} aria-label="Choose AI model">
              {!availableModels.length && <option value="">Configure a provider</option>}
              {availableModels.map((model) => <option value={model.id} key={model.id}>{model.providerName} · {model.label}</option>)}
            </select>
          </label>
          <div className="privacy-note"><ShieldCheck size={14} /><span>Built with privacy and safety in mind</span></div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
          <div className="mobile-brand"><VeyroMark /></div>
          <div className="topbar-context"><span className="context-dot" /> AI Assistant <span className="context-separator">/</span> <span className="context-muted">New conversation</span></div>
          <div className="topbar-right"><span className={`connection-indicator ${apiStatus}`} /><span className="connection-text">{apiStatus === "checking" ? "Connecting" : apiStatus === "online" ? "API connected" : "API offline"}</span><button className="top-new-chat" onClick={startNewChat}><Plus size={15} /><span>New chat</span></button></div>
        </header>

        <section className={`conversation ${messages.length ? "conversation-active" : ""}`}>
          {messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-eyebrow"><span className="eyebrow-line" /><Sparkles size={13} /><span>YOUR AI WORKSPACE</span><span className="eyebrow-line" /></div>
              <div className="welcome-emblem"><VeyroMark compact /><span className="emblem-orbit orbit-one" /><span className="emblem-orbit orbit-two" /></div>
              <h1>Think beyond<br /><span>the ordinary.</span></h1>
              <p className="welcome-description">Meet Veyro, your space to explore ideas, solve problems,<br className="desktop-break" /> and turn curiosity into something extraordinary.</p>
              <div className="prompt-grid">
                {starterPrompts.map(({ icon: Icon, title, text }) => (
                  <button className="prompt-card" key={title} onClick={() => sendMessage(text)}>
                    <span className="prompt-icon"><Icon size={17} /></span>
                    <span className="prompt-title">{title}</span>
                    <span className="prompt-text">{text}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message, index) => (
                <article className={`message-row ${message.role}`} key={`${index}-${message.role}`}>
                  {message.role === "assistant" ? <div className="assistant-avatar"><VeyroMark compact /></div> : <div className="user-avatar">Y</div>}
                  <div className="message-body">
                    <div className="message-author">{message.role === "assistant" ? "Veyro" : "You"}</div>
                    <div className="message-content">{message.content}</div>
                  </div>
                </article>
              ))}
              {loading && <article className="message-row assistant"><div className="assistant-avatar"><VeyroMark compact /></div><div className="message-body"><div className="message-author">Veyro</div><div className="typing-indicator"><span /><span /><span /></div></div></article>}
              <div ref={endRef} />
            </div>
          )}
        </section>

        <footer className="composer-area">
          {error && <div className="error-banner" role="status">{error}<button onClick={() => setError("")} aria-label="Dismiss message"><X size={14} /></button></div>}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
            <textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} placeholder="Message Veyro..." rows={1} aria-label="Message Veyro" />
            <div className="composer-bottom"><span className="composer-hint"><span className="hint-key">↵</span> to send <span className="hint-divider">·</span> <span className="hint-key">Shift ↵</span> for new line</span><button className="send-button" type="submit" disabled={!input.trim() || loading} aria-label="Send message">{loading ? <span className="send-spinner" /> : <ArrowUp size={18} />}</button></div>
          </form>
          <p className="disclaimer">Veyro is an AI assistant and can make mistakes. Verify important information.</p>
        </footer>
      </main>
    </div>
  );
}

export default App;
