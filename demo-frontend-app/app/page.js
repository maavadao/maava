"use client";

import { useEffect, useRef, useState } from "react";

const DEFAULT_API = "http://localhost:8080";

export default function Demo() {
  const [apiUrl, setApiUrl] = useState(DEFAULT_API);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState({ text: "Not connected.", error: false });
  const [me, setMe] = useState(null);
  const [agents, setAgents] = useState([]);
  const [conversations, setConversations] = useState([]);

  // Chat state
  const [chatAgentId, setChatAgentId] = useState("");
  const [activeConv, setActiveConv] = useState("");
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const logRef = useRef(null);

  const api = async (path, options = {}) => {
    const res = await fetch(apiUrl.replace(/\/+$/, "") + path, {
      ...options,
      headers: {
        Authorization: "Bearer " + token.trim(),
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail ?? detail; } catch {}
      throw new Error(`${res.status} ${detail}`);
    }
    return res;
  };

  const apiJson = async (path, options) => (await api(path, options)).json();

  const refresh = async () => {
    const [meData, agentData, convData] = await Promise.all([
      apiJson("/v1/me"),
      apiJson("/v1/agents"),
      apiJson("/v1/conversations"),
    ]);
    setMe(meData);
    setAgents(agentData.agents);
    setConversations(convData.conversations);
  };

  const connect = async () => {
    localStorage.setItem("demo.apiUrl", apiUrl);
    localStorage.setItem("demo.token", token);
    setStatus({ text: "Connecting…", error: false });
    try {
      await refresh();
      setStatus({ text: "Connected.", error: false });
    } catch (err) {
      setStatus({ text: err.message, error: true });
    }
  };

  useEffect(() => {
    const savedUrl = localStorage.getItem("demo.apiUrl");
    const savedToken = localStorage.getItem("demo.token");
    if (savedUrl) setApiUrl(savedUrl);
    if (savedToken) setToken(savedToken);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [messages]);

  const createAgent = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("/v1/agents", {
        method: "POST",
        body: JSON.stringify({
          name: f.get("name"),
          description: f.get("description") || null,
          model: f.get("model"),
          system_prompt: f.get("system_prompt") || "",
          visibility: f.get("visibility"),
        }),
      });
      e.target.reset();
      setStatus({ text: "Agent created.", error: false });
      await refresh();
    } catch (err) {
      setStatus({ text: err.message, error: true });
    }
  };

  const openConversation = async (convId) => {
    setActiveConv(convId);
    if (!convId) { setMessages([]); return; }
    const data = await apiJson(`/v1/conversations/${convId}/messages`);
    setMessages(
      data.messages.map((m) => ({
        role: m.role,
        text: m.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
      }))
    );
  };

  const send = async (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || streaming) return;
    try {
      let convId = activeConv;
      if (!convId) {
        if (!chatAgentId) {
          setStatus({ text: "Pick an agent to chat with.", error: true });
          return;
        }
        const created = await apiJson("/v1/conversations", {
          method: "POST",
          body: JSON.stringify({ agent_id: chatAgentId }),
        });
        convId = created.id;
        setActiveConv(convId);
      }
      setDraft("");
      setStreaming(true);
      setMessages((m) => [...m, { role: "user", text }, { role: "assistant", text: "" }]);

      const res = await api(`/v1/conversations/${convId}/chat`, {
        method: "POST",
        body: JSON.stringify({ message: text }),
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop();
        for (const evt of events) {
          const line = evt.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const data = JSON.parse(line.slice(6));
          if (data.type === "delta") {
            setMessages((m) => {
              const copy = m.slice();
              copy[copy.length - 1] = {
                role: "assistant",
                text: copy[copy.length - 1].text + data.text,
              };
              return copy;
            });
          } else if (data.type === "error") {
            setStatus({ text: data.detail, error: true });
          }
        }
      }
      const convData = await apiJson("/v1/conversations");
      setConversations(convData.conversations);
    } catch (err) {
      setStatus({ text: err.message, error: true });
    } finally {
      setStreaming(false);
    }
  };

  return (
    <main>
      <h1>Agent Platform — Demo Frontend</h1>
      <p className="muted">
        Minimal Next.js demo client. Run <code>make demo-seed</code> to get a token.
      </p>

      <section>
        <h2>Connection</h2>
        <label>
          API base URL
          <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} />
        </label>
        <label>
          Bearer token (from make demo-seed)
          <textarea
            rows={3}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="eyJhbGciOi..."
          />
        </label>
        <button onClick={connect}>Connect</button>
        <div className={status.error ? "error" : "muted"}>{status.text}</div>
      </section>

      <section>
        <h2>Who am I</h2>
        {me ? (
          <p>
            {me.user?.email ?? "unknown user"} — orgs:{" "}
            {me.orgs.map((o) => `${o.name} (${o.role})`).join(", ") || "none"}
          </p>
        ) : (
          <span className="muted">Not connected.</span>
        )}
      </section>

      <section>
        <h2>Chat</h2>
        {!me ? (
          <span className="muted">Connect first.</span>
        ) : (
          <>
            <label>
              Conversation
              <select value={activeConv} onChange={(e) => openConversation(e.target.value)}>
                <option value="">— new conversation —</option>
                {conversations.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.agent_name}: {c.title || c.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            {!activeConv && (
              <label>
                Agent
                <select value={chatAgentId} onChange={(e) => setChatAgentId(e.target.value)}>
                  <option value="">— pick an agent —</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({a.model})</option>
                  ))}
                </select>
              </label>
            )}
            <div className="chat-log" ref={logRef}>
              {messages.length === 0 && (
                <span className="muted">No messages yet.</span>
              )}
              {messages.map((m, i) => (
                <div className="msg" key={i}>
                  <span className="role">{m.role}</span>
                  {m.text || (streaming && i === messages.length - 1 ? "…" : "")}
                </div>
              ))}
            </div>
            <form className="chat-input" onSubmit={send}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Say something…"
                disabled={streaming}
              />
              <button type="submit" disabled={streaming}>
                {streaming ? "…" : "Send"}
              </button>
            </form>
          </>
        )}
      </section>

      <section>
        <h2>Agents</h2>
        {!me ? (
          <span className="muted">Not connected.</span>
        ) : agents.length === 0 ? (
          <span className="muted">No agents yet — create one below.</span>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>Model</th><th>Visibility</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>{a.model}</td>
                  <td>{a.visibility}</td>
                  <td>{new Date(a.updated_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Create agent</h2>
        <form onSubmit={createAgent}>
          <label>Name <input name="name" required maxLength={200} /></label>
          <label>Description <input name="description" /></label>
          <label>
            Model <input name="model" defaultValue="anthropic/claude-sonnet-4-6" required />
          </label>
          <label>System prompt <textarea name="system_prompt" rows={2} /></label>
          <label>
            Visibility
            <select name="visibility" defaultValue="private">
              <option value="private">private</option>
              <option value="org">org</option>
            </select>
          </label>
          <button type="submit">Create</button>
        </form>
      </section>
    </main>
  );
}
