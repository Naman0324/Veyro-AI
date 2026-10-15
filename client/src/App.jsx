import { useEffect, useRef, useState } from "react";
import {
  ArrowUp, Plus, Menu, X, MessageSquare, Code2, FileText, Image as ImageIcon,
  Sparkles, PanelLeftClose, ShieldCheck, LogOut, Trash2, Eye, EyeOff
} from "lucide-react";
import "./App.css";

const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const starterPrompts = [
  { icon: Code2, title: "Help me write code", text: "Explain a JavaScript function with a simple example." },
  { icon: FileText, title: "Understand a document", text: "How can I summarize a long PDF document?" },
  { icon: Sparkles, title: "Explore an idea", text: "Give me a practical project idea for a beginner web developer." },
  { icon: ImageIcon, title: "Create something", text: "Help me write a detailed prompt for a futuristic city illustration." }
];

function VeyroMark() {
  return <div className="brand"><svg className="brand-symbol" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M8 30a16 16 0 0 0 32 0M15 26c2-4 5-6 9-6s7 2 9 6" stroke="#9E9FFF" strokeWidth="3" strokeLinecap="round"/><circle cx="24" cy="15" r="3" fill="#C2A3FF"/></svg><span className="brand-word">veyro<span className="brand-dot">.</span></span></div>;
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
  const [user, setUser] = useState(null);
  const [csrfToken, setCsrfToken] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [legalPage, setLegalPage] = useState("");
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  async function api(path, options = {}) {
    const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
    if (["POST", "DELETE", "PUT", "PATCH"].includes(options.method)) headers["X-CSRF-Token"] = csrfToken;
    const response = await fetch(`${API_URL}${path}`, { credentials: "include", ...options, headers });
    return response;
  }

  async function loadConversations() {
    const response = await api("/api/conversations");
    if (response.ok) setConversations((await response.json()).conversations || []);
  }

  useEffect(() => {
    let active = true;
    const requestJson = async (path) => {
      const response = await fetch(`${API_URL}${path}`, { credentials: "include" });
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      return response.json();
    };
    Promise.allSettled([requestJson("/api/health"), requestJson("/api/models"), requestJson("/api/auth/me")])
      .then(([healthResult, modelResult, authResult]) => {
        if (!active) return;
        setApiStatus(healthResult.status === "fulfilled" && healthResult.value.status === "ok" ? "online" : "offline");
        if (modelResult.status === "fulfilled") {
          setAvailableModels(modelResult.value.models || []);
          setSelectedModel(modelResult.value.defaultModel || "");
        }
        if (authResult.status === "fulfilled") {
          setUser(authResult.value.user);
          setCsrfToken(authResult.value.csrfToken || "");
        }
      });
    return () => { active = false; };
  }, []);

  useEffect(() => { if (user) loadConversations().catch(() => {}); else setConversations([]); }, [user]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, loading]);

  async function submitAuth(event) {
    event.preventDefault(); setAuthBusy(true); setAuthError("");
    try {
      const response = await api(`/api/auth/${authMode === "signup" ? "signup" : "login"}`, { method: "POST", body: JSON.stringify({ email: authEmail, password: authPassword }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not sign in.");
      setUser(data.user); setCsrfToken(data.csrfToken); setAuthPassword("");
    } catch (err) { setAuthError(err.message || "Could not connect to Veyro."); }
    finally { setAuthBusy(false); }
  }

  async function signOut() {
    try { const response = await api("/api/auth/logout", { method: "POST", body: "{}" }); if (!response.ok) throw new Error(); setUser(null); setMessages([]); setConversationId(null); }
    catch { setError("Could not sign out. Please try again."); }
  }

  async function deleteAccount() {
    if (!window.confirm("Delete your account and all saved conversations? This cannot be undone.")) return;
    try { const response = await api("/api/auth/account", { method: "DELETE" }); if (!response.ok) throw new Error(); setUser(null); setMessages([]); setConversationId(null); }
    catch { setError("Could not delete your account. Please try again."); }
  }

  async function openConversation(id) {
    setError("");
    try {
      const response = await api(`/api/conversations/${id}`); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not open conversation.");
      setConversationId(id); setMessages(data.messages || []); if (data.conversation.model_id) setSelectedModel(data.conversation.model_id); setSidebarOpen(false);
    } catch (err) { setError(err.message); }
  }

  async function deleteConversation(id) {
    try {
      const response = await api(`/api/conversations/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete that conversation.");
      setConversations((items) => items.filter((item) => item.id !== id));
      if (conversationId === id) startNewChat();
    } catch (err) { setError(err.message); }
  }

  async function sendMessage(text = input) {
    const prompt = text.trim();
    if (!prompt || loading) return;
    if (!selectedModel) { setError("Add at least one provider API key to the server, then restart the API."); return; }
    const nextMessages = [...messages, { role: "user", content: prompt }];
    setMessages([...nextMessages, { role: "assistant", content: "" }]); setInput(""); setError(""); setLoading(true); setSidebarOpen(false);
    let partialReply = ""; let activeConversationId = conversationId;
    try {
      const response = await api("/api/chat", { method: "POST", body: JSON.stringify({ conversationId: activeConversationId, message: prompt, model: selectedModel }) });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "Veyro could not complete that request."); }
      if (!response.body) throw new Error("Streaming is not available in this browser.");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let finished = false;
      while (!finished) {
        const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || "";
        for (const block of events) {
          const eventName = block.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim();
          const dataLine = block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim(); if (!dataLine) continue;
          const eventData = JSON.parse(dataLine);
          if (eventName === "start" && eventData.conversationId) { activeConversationId = eventData.conversationId; setConversationId(eventData.conversationId); }
          if (eventName === "token") { partialReply += eventData.text || ""; setMessages([...nextMessages, { role: "assistant", content: partialReply }]); }
          if (eventName === "error") throw new Error(eventData.message || "Veyro could not complete that request.");
          if (eventName === "done") finished = true;
        }
        if (done) finished = true;
      }
      if (!partialReply) setMessages(nextMessages);
      await loadConversations();
    } catch (err) {
      setMessages(partialReply ? [...nextMessages, { role: "assistant", content: partialReply }] : nextMessages);
      setError(err.message || "Could not connect to Veyro. Check that the backend is running.");
    } finally { setLoading(false); inputRef.current?.focus(); }
  }

  function startNewChat() { setMessages([]); setConversationId(null); setError(""); setInput(""); setSidebarOpen(false); inputRef.current?.focus(); }

  if (!user && legalPage) return <main className="auth-screen"><article className="auth-card legal-card"><VeyroMark /><button className="legal-back" onClick={() => setLegalPage("")}>← Back to sign in</button><h1>{legalPage === "privacy" ? "Privacy overview" : "Terms of use"}</h1>{legalPage === "privacy" ? <><p>Veyro is a portfolio application. Before public launch, replace this overview with a policy reviewed for your business and local law, and add a support contact.</p><h2>Information this version stores</h2><p>Account email, password hash, session data, conversation titles, selected model IDs, prompts, responses, and timestamps are stored in its PostgreSQL database. Passwords are hashed; the original password is not stored.</p><h2>AI providers</h2><p>When you send a message, Veyro sends the conversation context and selected model request to that model provider to generate a response. Provider terms and data handling also apply.</p><h2>Cookies, retention, and deletion</h2><p>An essential HTTP-only session cookie keeps you signed in. Saved chats remain until you delete them by deleting your account or the database is removed. Database backup retention depends on the host. This demo does not currently include email verification or password recovery.</p><h2>Contact</h2><p>Add a monitored support email and the operator's legal identity here before enabling public registration.</p></> : <><p>Veyro is provided as an AI chat application. AI responses may be inaccurate or incomplete; verify important information before relying on it.</p><h2>Accounts and content</h2><p>Keep your account credentials private. You are responsible for the prompts you submit and for using the selected AI provider under its applicable terms.</p><h2>Availability and costs</h2><p>Availability may depend on the hosting platform and configured AI provider. Model usage can incur provider charges for the operator. Do not enable public access until spending limits and abuse protections are configured.</p><h2>Before public launch</h2><p>These starter terms need review and completion with the operator's identity, jurisdiction, support contact, and any applicable service commitments.</p></>}</article></main>;

  if (!user) return (
    <main className="auth-screen">
      <div className="auth-layout">
        <section className="auth-story" aria-label="About Veyro">
          <VeyroMark />
          <div className="auth-story-copy">
            <p className="auth-eyebrow">A CLEARER WAY TO THINK</p>
            <h2>Make room<br />for <span>better ideas.</span></h2>
            <p className="auth-story-description">One thoughtful workspace for questions, creative sparks, and the conversations you want to keep.</p>
            <div className="auth-highlights">
              <div><span className="auth-highlight-icon"><MessageSquare size={17} /></span><span><strong>Conversations that stay</strong><small>Pick up where your thinking left off.</small></span></div>
              <div><span className="auth-highlight-icon"><Sparkles size={17} /></span><span><strong>Your choice of AI</strong><small>Move between the models you use.</small></span></div>
            </div>
          </div>
          <p className="auth-story-footer">A calmer space for curious minds.</p>
        </section>
        <section className="auth-card">
          <p className="auth-eyebrow">YOUR AI WORKSPACE</p>
          <h1>{authMode === "signup" ? "Create your account" : "Welcome back"}</h1>
          <p className="auth-subtitle">Sign in to use Veyro and keep your conversations saved to your account.</p>
          {apiStatus === "offline" && <div className="error-banner">Veyro's database is not connected. Add DATABASE_URL and SESSION_SECRET in Vercel, then redeploy.</div>}
          <form className="auth-form" onSubmit={submitAuth}>
            <label>Email address<input type="email" autoComplete="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required maxLength={254} /></label>
            <label>Password<span className="password-input-wrap"><input type={showPassword ? "text" : "password"} autoComplete={authMode === "signup" ? "new-password" : "current-password"} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required minLength={10} maxLength={128} /><button className="password-visibility-toggle" type="button" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} title={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}</button></span></label>
            {authMode === "signup" && <p className="password-hint">Use at least 10 characters.</p>}
            {authError && <div className="error-banner" role="alert">{authError}</div>}
            <button className="auth-submit" disabled={authBusy || apiStatus === "offline"}>{authBusy ? "Please wait…" : authMode === "signup" ? "Create account" : "Sign in"}</button>
          </form>
          <p className="auth-switch">{authMode === "signup" ? "Already have an account?" : "New to Veyro?"} <button onClick={() => { setAuthMode(authMode === "signup" ? "login" : "signup"); setAuthError(""); }}>{authMode === "signup" ? "Sign in" : "Create account"}</button></p>
          <p className="auth-privacy">Veyro stores your email and saved chats to provide the service. Prompts are sent to the AI provider you select. Your session uses an essential secure cookie; provider keys stay on the server. <button onClick={() => setLegalPage("privacy")}>Privacy</button> · <button onClick={() => setLegalPage("terms")}>Terms</button></p>
        </section>
      </div>
    </main>
  );

  return (
    <div className="app-shell">
      {sidebarOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top"><VeyroMark /><button className="icon-button close-sidebar" aria-label="Close menu" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
        <button className="new-chat-button" onClick={startNewChat}><Plus size={17} /> <span>New chat</span> <span className="shortcut">Ctrl K</span></button>
        <div className="nav-label">WORKSPACE</div>
        <nav className="workspace-nav" aria-label="Workspace"><button className="nav-item active" onClick={() => setSidebarOpen(false)}><MessageSquare size={17} /><span>AI Assistant</span><span className="active-dot" /></button></nav>
        <div className="sidebar-divider" />
        <div className="history-heading"><span className="nav-label">SAVED CHATS</span><PanelLeftClose size={15} /></div>
        {conversations.length ? <div className="saved-chat-list">{conversations.map((chat) => <div className="chat-history-row" key={chat.id}><button className={`history-item ${conversationId === chat.id ? "selected" : ""}`} onClick={() => openConversation(chat.id)}><MessageSquare size={15} /><span>{chat.title}</span></button><button className="delete-chat-button" title="Delete conversation" aria-label={`Delete ${chat.title}`} onClick={() => deleteConversation(chat.id)}><Trash2 size={13} /></button></div>)}</div> : <p className="empty-history">Your saved conversations will appear here.</p>}
        <div className="sidebar-bottom">
          <label className="model-card" htmlFor="model-select"><div className="model-icon"><Sparkles size={16} /></div><div className="model-copy"><strong>Choose a model</strong><span>{availableModels.length ? `${availableModels.length} configured` : "No provider keys configured"}</span></div><select id="model-select" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={!availableModels.length || loading} aria-label="Choose AI model">{!availableModels.length && <option value="">Configure a provider</option>}{availableModels.map((model) => <option value={model.id} key={model.id}>{model.providerName} · {model.label}</option>)}</select></label>
          <div className="account-card"><span>{user.email}</span><div><button title="Sign out" aria-label="Sign out" onClick={signOut}><LogOut size={15} /></button><button title="Delete account" aria-label="Delete account and saved chats" onClick={deleteAccount}><Trash2 size={15} /></button></div></div>
          <div className="privacy-note"><ShieldCheck size={14} /><span>Private account conversations</span></div>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><div className="mobile-brand"><VeyroMark /></div><div className="topbar-context"><span className="context-dot" /> AI Assistant <span className="context-separator">/</span> <span className="context-muted">{messages[0]?.content?.slice(0, 34) || "New conversation"}</span></div><div className="topbar-right">{import.meta.env.DEV && <><span className={`connection-indicator ${apiStatus}`} /><span className="connection-text">{apiStatus === "checking" ? "Connecting" : apiStatus === "online" ? "API connected" : "API offline"}</span></>}<button className="top-new-chat" onClick={startNewChat}><Plus size={15} /><span>New chat</span></button></div></header>
        <section className={`conversation ${messages.length ? "conversation-active" : ""}`}>
          {messages.length === 0 ? <div className="welcome"><div className="welcome-eyebrow"><span className="eyebrow-line" /><Sparkles size={13} /><span>YOUR AI WORKSPACE</span><span className="eyebrow-line" /></div><h1>Think beyond<br /><span>the ordinary.</span></h1><p className="welcome-description">Meet Veyro, your space to explore ideas, solve problems,<br className="desktop-break" /> and turn curiosity into something extraordinary.</p><div className="prompt-grid">{starterPrompts.map(({ icon: Icon, title, text }) => <button className="prompt-card" key={title} onClick={() => sendMessage(text)}><span className="prompt-icon"><Icon size={17} /></span><span className="prompt-title">{title}</span><span className="prompt-text">{text}</span></button>)}</div></div> : <div className="message-list">{messages.map((message, index) => { if (loading && message.role === "assistant" && !message.content) return null; return <article className={`message-row ${message.role}`} key={`${index}-${message.role}`}><div className="message-body"><div className="message-author">{message.role === "assistant" ? "Veyro" : "You"}</div><div className="message-content">{message.content}</div></div></article>; })}{loading && (messages[messages.length - 1]?.role !== "assistant" || !messages[messages.length - 1]?.content) && <article className="message-row assistant" role="status" aria-label="Veyro is thinking"><div className="assistant-avatar thinking-avatar" aria-hidden="true"><span className="thinking-spinner" /></div><div className="message-body"><div className="message-author">Veyro is thinking</div><div className="typing-indicator"><span /><span /><span /></div></div></article>}<div ref={endRef} /></div>}
        </section>
        <footer className="composer-area">{error && <div className="error-banner" role="status">{error}<button onClick={() => setError("")} aria-label="Dismiss message"><X size={14} /></button></div>}<form className="composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}><textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} placeholder="Message Veyro..." rows={1} aria-label="Message Veyro" /><div className="composer-bottom"><span className="composer-hint"><span className="hint-key">↵</span> to send <span className="hint-divider">·</span> <span className="hint-key">Shift ↵</span> for new line</span><button className="send-button" type="submit" disabled={!input.trim() || loading} aria-label="Send message">{loading ? <span className="send-spinner" /> : <ArrowUp size={18} />}</button></div></form><p className="disclaimer">Veyro is an AI assistant and can make mistakes. Verify important information.</p></footer>
      </main>
    </div>
  );
}

export default App;
