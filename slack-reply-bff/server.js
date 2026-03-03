import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const port = process.env.PORT || 8787;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY が設定されていない");
  process.exit(1);
}

const BOT_NAME = process.env.BOT_NAME || "自分";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/health", (_req, res) => res.json({ ok: true }));

// content.js が .env の BOT_NAME を使うための設定
app.get("/config", (_req, res) => {
  res.json({ botName: BOT_NAME });
});

function sanitizeOneLine(text) {
  return String(text || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePunctuation(text) {
  return String(text || "").replace(/!/g, "！");
}

function insertLineBreakAfterMention(text, targetUser) {
  const t = sanitizeOneLine(text);
  const target = sanitizeOneLine(targetUser);
  if (!t || !target) return t;

  const head = new RegExp(`^@${escapeRegExp(target)}\\s*`);
  if (!head.test(t)) return t;

  const body = t.replace(head, "").trim();
  if (!body) return `@${target}`;
  return `@${target}\n${body}`;
}

function isMentionOnly(text, target) {
  const t = sanitizeOneLine(text);
  const name = sanitizeOneLine(target);
  if (!t || !name) return true;

  const headTag = new RegExp(`^<@${escapeRegExp(name)}>\\s*$`);
  const headAt = new RegExp(`^@${escapeRegExp(name)}\\s*$`);
  return headTag.test(t) || headAt.test(t);
}

function sanitizeSpeaker(text) {
  return sanitizeOneLine(text).slice(0, 80);
}

function extractResponseText(response) {
  const direct = sanitizeOneLine(response?.output_text || "");
  if (direct) return direct;

  const parts = [];
  const outputs = Array.isArray(response?.output) ? response.output : [];
  for (const item of outputs) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (!c) continue;
      if (c.type === "output_text" && typeof c.text === "string") {
        parts.push(c.text);
        continue;
      }
      if (c.type === "output_text" && c.text?.value) {
        parts.push(String(c.text.value));
        continue;
      }
      if (c.type === "text" && typeof c.text === "string") {
        parts.push(c.text);
        continue;
      }
      if (c.type === "text" && c.text?.value) {
        parts.push(String(c.text.value));
      }
    }
  }
  return sanitizeOneLine(parts.join(" "));
}

function normalizeMessages(rawMessages, botName) {
  if (!Array.isArray(rawMessages)) return [];

  return rawMessages
    .map((m) => {
      const text = sanitizeOneLine(m?.text || "");
      if (!text) return null;

      const sender = sanitizeSpeaker(m?.sender || "");
      const isSelf =
        typeof m?.isSelf === "boolean" ? m.isSelf : !!sender && sender === sanitizeSpeaker(botName);

      return {
        sender: sender || "不明",
        isSelf,
        text
      };
    })
    .filter(Boolean)
    .slice(-60);
}

function buildConversationLog(messages, fallbackText, botName) {
  if (!messages.length) return sanitizeOneLine(fallbackText || "");

  const log = messages
    .map((m, idx) => {
      const side = m.isSelf ? `自分:${botName}` : `相手:${m.sender}`;
      return `${idx + 1}. [${side}] ${m.text}`;
    })
    .join("\n");

  // 最後の文脈を優先して切り詰める（応答速度改善）
  const maxChars = 5000;
  if (log.length <= maxChars) return log;
  return `（古いログは省略）\n${log.slice(log.length - maxChars)}`;
}

function buildContextualFallback(targetUser, messages) {
  const lastOther = [...messages].reverse().find((m) => !m.isSelf && m.text)?.text || "";
  const cleaned = sanitizeOneLine(lastOther)
    .replace(/<@[^>]+>/g, " ")
    .replace(/(^|\s)@[^\s@]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned) {
    return `@${targetUser} ありがとうございます！${cleaned.slice(0, 28)}の件、確認して進めます！`;
  }
  return `@${targetUser} ありがとうございます！内容を確認して進めます！`;
}

function normalizeSingleHeadMention(text, targetUser) {
  const target = sanitizeOneLine(targetUser);
  if (!target) return sanitizeOneLine(text);

  let t = sanitizeOneLine(text);
  const headTag = new RegExp(`^<@${escapeRegExp(target)}>\\s*`);
  const headAt = new RegExp(`^@${escapeRegExp(target)}\\s*`);

  // 先頭のターゲットメンションをいったん剥がして本文のみを正規化
  t = t.replace(headTag, "").replace(headAt, "").trim();

  // 本文中のメンション（Slack形式/通常@形式）を除去
  t = t.replace(/<@[^>]+>/g, " ");
  t = t.replace(/(^|\s)@[^\s@]+/g, " ");
  t = t.replace(/\s+/g, " ").trim();

  return sanitizeOneLine(`@${target} ${t}`.trim());
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mustStartWithMention(text, targetUser) {
  const t = sanitizeOneLine(text);
  const mention = `@${targetUser}`;
  return t.startsWith(mention);
}

// <@NAME> と @NAME の重複を除去し、先頭に <@NAME> を1回だけ残す
function cleanDuplicateMentions(text, target) {
  let t = sanitizeOneLine(text);
  const name = String(target || "").trim();
  if (!name) return t;

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const at = `@${name}`;
  const atEsc = esc(at);
  const slackTagEsc = esc(`<@${name}>`);

  // 1) Slack形式 <@name> を丸ごと削除（これ重要）
  t = t.replace(new RegExp(slackTagEsc, "g"), "");

  // 2) 先頭に @name が複数あれば1回に
  t = t.replace(new RegExp(`^(${atEsc}\\s*)+`), `${at} `);

  // 3) 先頭以外の @name を削除
  const placeholder = "__AT_PLACEHOLDER__";
  if (t.startsWith(at)) t = t.replace(at, placeholder);

  t = t.replace(new RegExp(atEsc, "g"), "");

  t = t.replace(placeholder, at);

  // 4) <> が残っていたら消す（保険）
  t = t.replace(/<>/g, "");

  // 5) 整形
  t = t.replace(/\s+/g, " ").trim();

  // 6) 先頭に無ければ付ける
  if (!t.startsWith(at)) t = `${at} ${t}`.trim();

  return t;
}

app.post("/draft", async (req, res) => {
  try {
    const { messageText, targetUser, messages: rawMessages } = req.body;

    if (typeof messageText !== "string" || !messageText.trim()) {
      return res.status(400).json({ error: "messageText is required" });
    }

    // この版は「スレッドで必ずメンション」仕様なので必須にする
    if (typeof targetUser !== "string" || !targetUser.trim()) {
      return res.status(400).json({ error: "targetUser is required" });
    }

    const safeTarget = sanitizeOneLine(targetUser);
    const normalizedMessages = normalizeMessages(rawMessages, BOT_NAME);
    const conversationLog = buildConversationLog(normalizedMessages, messageText, BOT_NAME);

    // 1回目プロンプト
    const prompt = `
あなたはSlackの返信文を作成する外部アシスタントである。あなた自身はSlackの参加者ではない。
自分（返信者）のSlack表示名は「${BOT_NAME}」である。

返信先（最後の「自分以外」の発言者）の表示名は「${safeTarget}」である。
必ず文頭を「@${safeTarget}」で開始せよ（このメンションは必須）。
自分（${BOT_NAME}）には絶対にメンションしないこと。自分宛の返信は生成しないこと。

重要:
- メンションは先頭の「@${safeTarget}」の1回だけにせよ
- 本文中に「@${safeTarget}」を二度と出すな

文脈の読み方:
- ログの [自分:...] は自分（${BOT_NAME}）の発言で、返信対象ではない
- ログの [相手:...] は自分以外の発言である
- 自分が直近で何を約束/依頼/回答したかを踏まえて返せ

出力は日本語で簡潔に3文以下。
常に丁寧語（です・ます調）を使い、タメ口を禁止する。
句点「。」の半分以上は「！」にせよ（必要なら文末は「！」で締めよ）。

会話ログ（古い→新しい）:
${conversationLog}
`.trim();

    const r1 = await client.responses.create({
      model: "gpt-5-mini",
      input: prompt,
      max_output_tokens: 140,
      reasoning: { effort: "minimal" }
    });

    let draft = extractResponseText(r1);

    if (!draft) console.warn("Empty model output on first attempt.");

    // 最終安全柵：先頭メンションが欠けていたら付ける
    if (!mustStartWithMention(draft, safeTarget)) {
      draft = sanitizeOneLine(`@${safeTarget} ${draft}`);
    }

    // 先頭メンション1つ＋本文中メンション除去
    draft = normalizeSingleHeadMention(draft, safeTarget);

    // 重複メンション除去（互換処理）
    draft = cleanDuplicateMentions(draft, safeTarget);

    // 自分メンションを消す（念のため）
    draft = draft.replaceAll(`<@${BOT_NAME}>`, "").replace(/\s+/g, " ").trim();

    // 空 or メンションのみなら軽い再生成を1回だけ試す
    if (!draft || isMentionOnly(draft, safeTarget)) {
      const retryPrompt = `
文頭は必ず @${safeTarget} で始めること。
日本語で1-2文、自然で具体的に返答すること。
常に丁寧語（です・ます調）を使い、タメ口を禁止する。
自分（${BOT_NAME}）へのメンション禁止。先頭以外の @ は禁止。

会話ログ（古い→新しい）:
${conversationLog}
`.trim();

      const r2 = await client.responses.create({
        model: "gpt-5-mini",
        input: retryPrompt,
        max_output_tokens: 120,
        reasoning: { effort: "minimal" }
      });
      const retryText = extractResponseText(r2);
      if (retryText) {
        draft = retryText;
        if (!mustStartWithMention(draft, safeTarget)) {
          draft = sanitizeOneLine(`@${safeTarget} ${draft}`);
        }
        draft = normalizeSingleHeadMention(draft, safeTarget);
        draft = cleanDuplicateMentions(draft, safeTarget);
        draft = draft.replaceAll(`<@${BOT_NAME}>`, "").replace(/\s+/g, " ").trim();
      }
    }

    // それでもダメな場合のみ最終フォールバック
    if (!draft || isMentionOnly(draft, safeTarget)) {
      draft = buildContextualFallback(safeTarget, normalizedMessages);
    }

    // 最終整形
    draft = sanitizeOneLine(draft);
    draft = normalizePunctuation(draft);
    draft = insertLineBreakAfterMention(draft, safeTarget);

    res.json({ draft });
  } catch (err) {
    console.error("OpenAI error:", err);
    res.status(500).json({ error: "OpenAI request failed" });
  }
});

app.listen(port, () => {
  console.log(`BFF running at http://localhost:${port}`);
});
