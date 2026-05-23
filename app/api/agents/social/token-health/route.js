import { NextResponse } from "next/server";

function getCronSecret() {
  return process.env.CRON_SECRET || process.env.SOCIAL_AGENT_CRON_SECRET || "";
}

async function checkLinkedIn() {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token) return { platform: "linkedin", status: "missing", detail: "LINKEDIN_ACCESS_TOKEN not set" };

  try {
    const res = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return { platform: "linkedin", status: "ok" };
    if (res.status === 401) return { platform: "linkedin", status: "expired", detail: "Token rejected (401)" };
    return { platform: "linkedin", status: "error", detail: `HTTP ${res.status}` };
  } catch (err) {
    return { platform: "linkedin", status: "error", detail: err.message };
  }
}

async function checkTwitter() {
  const apiKey = process.env.X_CONSUMER_KEY || process.env.X_API_KEY;
  const apiSecret = process.env.X_CONSUMER_SECRET || process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET || process.env.X_ACCESS_TOKEN_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    const missing = [
      ["X_CONSUMER_KEY", "X_API_KEY"],
      ["X_CONSUMER_SECRET", "X_API_SECRET"],
      ["X_ACCESS_TOKEN"],
      ["X_ACCESS_SECRET", "X_ACCESS_TOKEN_SECRET"],
    ]
      .filter((group) => !group.some((k) => process.env[k]))
      .map((group) => group.join(" or "))
      .join(", ");
    return { platform: "x", status: "missing", detail: `Missing: ${missing}` };
  }

  try {
    // Use Twitter OAuth1 to call /2/users/me — simple credential check
    const { TwitterApi } = await import("twitter-api-v2");
    const client = new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
      accessToken,
      accessSecret,
    });
    const me = await client.v2.me();
    if (me?.data?.id) return { platform: "x", status: "ok", username: me.data.username };
    return { platform: "x", status: "error", detail: "No user data returned" };
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("Invalid")) {
      return { platform: "x", status: "expired", detail: msg };
    }
    return { platform: "x", status: "error", detail: msg };
  }
}

async function checkFacebook() {
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;

  if (!token) return { platform: "facebook", status: "missing", detail: "FACEBOOK_PAGE_ACCESS_TOKEN not set" };
  if (!pageId) return { platform: "facebook", status: "missing", detail: "FACEBOOK_PAGE_ID not set" };

  try {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/${pageId}?fields=name,access_token&access_token=${token}`
    );
    if (res.ok) return { platform: "facebook", status: "ok" };
    const body = await res.json().catch(() => ({}));
    const code = body?.error?.code;
    if (res.status === 401 || code === 190) {
      return { platform: "facebook", status: "expired", detail: body?.error?.message || "Token expired (190)" };
    }
    return { platform: "facebook", status: "error", detail: body?.error?.message || `HTTP ${res.status}` };
  } catch (err) {
    return { platform: "facebook", status: "error", detail: err.message };
  }
}

async function notifySlack(results) {
  const webhook = process.env.SLACK_ALERTS_WEBHOOK;
  if (!webhook) return;

  const unhealthy = results.filter((r) => r.status !== "ok");
  if (!unhealthy.length) return; // All good — no noise

  const emoji = (status) => (status === "expired" ? "🔑" : status === "missing" ? "⚠️" : "❌");
  const label = (status) => (status === "expired" ? "Token Expired" : status === "missing" ? "Not Configured" : "Error");

  const fields = unhealthy.map((r) => ({
    type: "mrkdwn",
    text: `*${r.platform.toUpperCase()}:* ${emoji(r.status)} ${label(r.status)}\n${r.detail || ""}`,
  }));

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "🔑 Social Token Health Alert", emoji: true },
    },
    { type: "section", fields },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${unhealthy.length} platform(s) need attention | ${new Date().toISOString()}`,
        },
      ],
    },
  ];

  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks }),
  });
}

export async function POST(request) {
  const auth = request.headers.get("authorization") || "";
  const cronSecret = getCronSecret();
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [linkedin, twitter, facebook] = await Promise.allSettled([
    checkLinkedIn(),
    checkTwitter(),
    checkFacebook(),
  ]);

  const results = [linkedin, twitter, facebook].map((r) =>
    r.status === "fulfilled" ? r.value : { platform: "unknown", status: "error", detail: r.reason?.message }
  );

  await notifySlack(results);

  const allOk = results.every((r) => r.status === "ok");
  return NextResponse.json({
    healthy: allOk,
    results,
    timestamp: new Date().toISOString(),
  });
}

export async function GET(request) {
  return POST(request);
}
