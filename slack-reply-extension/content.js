// Slack Reply Draft Button (Safe, Thread-only, Mention-enforced via BFF)
// - Thread right pane open -> collect ALL thread messages + last non-self sender -> call BFF -> insert draft into thread composer
// - Uses BOT_NAME from BFF (/config) so .env value is the single source of truth
// - DOES NOT auto-send

const BFF_BASE = "http://localhost:8787";
const BFF_DRAFT_URL = `${BFF_BASE}/draft`;
const BFF_CONFIG_URL = `${BFF_BASE}/config`;

function normalizeText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

let SELF_NAME = null;

async function loadSelfNameFromBff() {
  try {
    const resp = await fetch(BFF_CONFIG_URL);
    if (!resp.ok) return null;
    const data = await resp.json();
    const name = normalizeText(data?.botName || "");
    return name || null;
  } catch {
    return null;
  }
}

function ensureStyles() {
  const id = "slack-reply-draft-btn-style";
  if (document.getElementById(id)) return;

  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
    .slack-reply-draft-btn {
      position: fixed;
      right: 16px;
      bottom: 18px;
      z-index: 2147483647;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(0,0,0,0.15);
      background: white;
      box-shadow: 0 6px 22px rgba(0,0,0,0.12);
      font: 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      cursor: pointer;
      user-select: none;
    }
    .slack-reply-draft-btn:hover { filter: brightness(0.98); }
    .slack-reply-draft-btn[aria-busy="true"] { opacity: 0.65; cursor: progress; }

    .slack-reply-draft-toast {
      position: fixed;
      right: 16px;
      bottom: 64px;
      z-index: 2147483647;
      padding: 8px 10px;
      border-radius: 10px;
      background: rgba(20,20,20,0.92);
      color: white;
      font: 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      max-width: 420px;
      white-space: pre-wrap;
    }
  `;
  document.head.appendChild(style);
}

function showToast(msg, ms = 1800) {
  const el = document.createElement("div");
  el.className = "slack-reply-draft-toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function fetchDraftFromBff(messageText, targetUser, messages = []) {
  const resp = await fetch(BFF_DRAFT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageText, targetUser, messages })
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`BFF error: ${resp.status} ${body}`);
  }
  const data = await resp.json();
  return String(data.draft || "").trim();
}

function insertDraftIntoComposer(composerEl, text) {
  composerEl.focus();

  // 既に入力があるなら上書きしない（事故防止）
  const existing = normalizeText(composerEl.innerText);
  if (existing.length > 0) return false;

  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

  // Slack は "\n" や <br> を段落扱いして空行っぽく見える場合があるため、
  // メンション直後は Unicode line separator (U+2028) を使って1行改行に寄せる。
  const mentionBreak = normalized.match(/^(@[^\n]+)\n(.+)$/s);
  if (mentionBreak) {
    const [, head, body] = mentionBreak;
    composerEl.textContent = `${head}\u2028${body.trimStart()}`;
  } else {
    composerEl.textContent = normalized;
  }
  composerEl.dispatchEvent(new InputEvent("input", { bubbles: true }));
  return true;
}

/**
 * Thread panel detection (right pane)
 */
function findThreadRoot() {
  const candidates = [
    document.querySelector('[data-qa="thread_panel"]'),
    document.querySelector('[data-qa="thread-view"]'),
    document.querySelector('[data-qa="threads_flexpane"]'),
    document.querySelector('[aria-label*="スレッド"]'),
    document.querySelector('[aria-label*="Thread"]')
  ].filter(Boolean);

  for (const el of candidates) {
    const rect = el.getBoundingClientRect?.();
    if (rect && rect.width > 200 && rect.height > 200) return el;
  }
  return candidates[0] || null;
}

function findComposerEditableWithin(root) {
  if (!root) return null;
  const candidates = Array.from(root.querySelectorAll('[contenteditable="true"]'));
  const preferred =
    candidates.find((el) => /message/i.test(el.getAttribute("aria-label") || "")) ||
    candidates.find((el) => el.closest?.('[data-qa="message_input"]')) ||
    candidates[0];
  return preferred || null;
}

/**
 * Thread view: collect ALL messages (scoped) with safety clipping
 */
function extractThreadMessagesWithMetaWithin(root, selfName, opts = {}) {
  if (!root) return null;

  const { maxMessages = 60, maxChars = 6000 } = opts;
  const self = normalizeText(selfName || "");

  const textSelectors = [
    '[data-qa="message-text"]',
    '.c-message_kit__text',
    '.c-message_kit__blocks',
    '[data-stringify-text]',
    '[dir="auto"]'
  ];

  const containers = Array.from(
    root.querySelectorAll('[data-qa="message_container"], [role="listitem"], [data-qa="virtual-list-item"]')
  );

  let messages = [];
  let lastSender = "";

  if (containers.length > 0) {
    for (const c of containers) {
      let text = "";
      for (const sel of textSelectors) {
        const el = c.querySelector(sel);
        if (!el) continue;
        const t = normalizeText(el.innerText || el.textContent || "");
        if (t) { text = t; break; }
      }
      if (!text) continue;
      if (text.length < 2) continue;

      const senderSelectors = [
        '[data-qa="message_sender_name"]',
        '[data-qa="message_sender"]',
        'button.c-message__sender_button',
        'a.c-message__sender_button',
        '.c-message__sender',
        '.c-message_kit__sender',
        'button[aria-label*="プロフィール"]',
        'button[aria-label*="Profile"]'
      ];

      let sender = "";
      for (const sSel of senderSelectors) {
        const el = c.querySelector(sSel);
        if (!el) continue;
        const name = normalizeText(el.innerText || el.textContent || "");
        if (name) { sender = name; break; }
      }
      if (!sender) sender = lastSender || "不明";
      lastSender = sender;

      messages.push({
        sender,
        isSelf: !!self && sender === self,
        text
      });
    }
  } else {
    const nodes = [];
    for (const sel of textSelectors) {
      root.querySelectorAll(sel).forEach((n) => nodes.push(n));
    }
    const unique = Array.from(new Set(nodes));
    for (const el of unique) {
      const t = normalizeText(el.innerText || el.textContent || "");
      if (!t || t.length < 2) continue;
      messages.push({
        sender: "不明",
        isSelf: false,
        text: t
      });
    }
  }

  if (messages.length === 0) return null;

  // 件数制限（最新側優先）
  if (messages.length > maxMessages) {
    messages = messages.slice(messages.length - maxMessages);
  }

  // BFF送信用の旧文字列も併せて維持
  let joined = messages.map((m) => m.text).join(" / ");

  // 文字数制限（最新側優先）
  if (joined.length > maxChars) {
    joined = "（古いメッセージは省略）… " + joined.slice(joined.length - maxChars);
  }

  return {
    messageText: joined,
    messages
  };
}

/**
 * Thread view: extract last NON-SELF sender display name
 * - 最後のコンテナが入力欄や区切りになることがあるので「本文があるメッセージ」だけを対象に末尾から逆走査する
 */
function extractLastNonSelfSenderNameWithin(root, selfName) {
  if (!root) return null;

  const self = normalizeText(selfName || "");
  if (!self) return null;

  const containers = Array.from(
    root.querySelectorAll('[data-qa="message_container"], [role="listitem"], [data-qa="virtual-list-item"]')
  );
  if (containers.length === 0) return null;

  const textSelectors = [
    '[data-qa="message-text"]',
    '.c-message_kit__text',
    '.c-message_kit__blocks',
    '[data-stringify-text]',
    '[dir="auto"]'
  ];

  const senderSelectors = [
    '[data-qa="message_sender_name"]',
    '[data-qa="message_sender"]',
    'button.c-message__sender_button',
    'a.c-message__sender_button',
    '.c-message__sender',
    '.c-message_kit__sender',
    'button[aria-label*="プロフィール"]',
    'button[aria-label*="Profile"]'
  ];

  for (let i = containers.length - 1; i >= 0; i--) {
    const c = containers[i];

    // 本文があるコンテナだけを対象にする
    let hasText = false;
    for (const sel of textSelectors) {
      const el = c.querySelector(sel);
      if (!el) continue;
      const t = normalizeText(el.innerText || el.textContent || "");
      if (t && t.length >= 2) { hasText = true; break; }
    }
    if (!hasText) continue;

    // 送信者名
    let sender = "";
    for (const sSel of senderSelectors) {
      const el = c.querySelector(sSel);
      if (!el) continue;
      const name = normalizeText(el.innerText || el.textContent || "");
      if (name) { sender = name; break; }
    }
    if (!sender) continue;

    // 自分は除外
    if (sender === self) continue;

    return sender;
  }

  return null;
}

function ensureButton() {
  ensureStyles();

  const id = "slack-reply-draft-btn";
  if (document.getElementById(id)) return;

  const btn = document.createElement("button");
  btn.id = id;
  btn.className = "slack-reply-draft-btn";
  btn.type = "button";
  btn.textContent = "返信案を作る";
  btn.setAttribute("aria-busy", "false");

  btn.addEventListener("click", async () => {
    if (btn.getAttribute("aria-busy") === "true") return;

    // スレッド専用：まずスレッドを開いているか確認
    const threadRoot = findThreadRoot();
    if (!threadRoot) {
      showToast("スレッド右ペインを開いてから使え（この版はスレッド専用）", 2400);
      return;
    }

    // BFFから SELF_NAME（.env由来）を取得
    if (!SELF_NAME) {
      SELF_NAME = await loadSelfNameFromBff();
    }
    if (!SELF_NAME) {
      showToast("BFFからBOT_NAMEを取得できない（/config を確認）", 2600);
      return;
    }

    const composer = findComposerEditableWithin(threadRoot);
    if (!composer) {
      showToast("スレッド返信の入力欄が見つからない", 2400);
      return;
    }

    // 上書き事故防止
    if (normalizeText(composer.innerText).length > 0) {
      showToast("入力欄に既に文字があるので上書きしない", 2200);
      return;
    }

    const extracted = extractThreadMessagesWithMetaWithin(threadRoot, SELF_NAME, { maxMessages: 60, maxChars: 6000 });
    if (!extracted) {
      showToast("スレッド内の本文を拾えなかった（DOM差分の可能性）", 2600);
      return;
    }

    const { messageText, messages } = extracted;
    const latestOther = [...messages].reverse().find((m) => !m.isSelf && m.sender && m.sender !== "不明");
    const targetUser = latestOther?.sender || extractLastNonSelfSenderNameWithin(threadRoot, SELF_NAME);
    if (!targetUser) {
      showToast("最後の『自分以外』の発言者名を拾えなかった（メンション必須のため中断）", 3000);
      return;
    }

    btn.setAttribute("aria-busy", "true");
    btn.textContent = "生成中…";

    try {
      const draft = await fetchDraftFromBff(messageText, targetUser, messages);
      if (!draft) {
        showToast("返信案が空だった", 2200);
        return;
      }

      const ok = insertDraftIntoComposer(composer, draft);
      if (!ok) {
        showToast("入力欄に既に文字があるので挿入しない", 2200);
        return;
      }

      showToast("スレッド返信に下書きを挿入した（送信は手動）", 2200);
    } catch (e) {
      showToast(`失敗: ${String(e?.message || e)}`, 3200);
    } finally {
      btn.setAttribute("aria-busy", "false");
      btn.textContent = "返信案を作る";
    }
  });

  document.body.appendChild(btn);
}

(function main() {
  ensureButton();
  const obs = new MutationObserver(() => ensureButton());
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
