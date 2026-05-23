import { NextResponse } from "next/server";
import { upsertTrends, pruneOldTrends, getTrendStats } from "@/lib/trendStore";

function getCronSecret() {
  return process.env.CRON_SECRET || process.env.SOCIAL_AGENT_CRON_SECRET || "";
}

async function fetchAll() {
  const fetchHN = () =>
    fetch("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30")
      .then((r) => r.json())
      .then((d) => (d.hits ?? []).map((h) => ({ title: h.title ?? "", url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`, source: "HackerNews", description: h.title ?? "", points: h.points || 0 })))
      .catch(() => []);

  const fetchReddit = async () => {
    const subs = ["artificial", "MachineLearning", "startups"];
    const results = [];
    for (const sub of subs) {
      try {
        const d = await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=15`, { headers: { "User-Agent": "GhostAISolutions-TrendBot/1.0" } }).then((r) => r.json());
        for (const item of d?.data?.children ?? []) {
          const p = item.data;
          if (!p.title || p.stickied) continue;
          results.push({ title: p.title, url: p.url?.startsWith("http") ? p.url : `https://reddit.com${p.permalink}`, source: `Reddit r/${sub}`, description: (p.selftext || p.title).slice(0, 300), points: p.score || 0 });
        }
      } catch { /* skip */ }
    }
    return results;
  };

  const fetchDevTo = () =>
    fetch("https://dev.to/api/articles?state=rising&per_page=20&tags=ai,machinelearning,automation")
      .then((r) => r.json())
      .then((d) => (Array.isArray(d) ? d : []).map((a) => ({ title: a.title ?? "", url: a.url ?? "", source: "Dev.to", description: a.description || a.title || "", points: a.positive_reactions_count || 0 })))
      .catch(() => []);

  const [hn, reddit, devto] = await Promise.all([fetchHN(), fetchReddit(), fetchDevTo()]);
  return [...hn, ...reddit, ...devto];
}

const HIGH_KEYWORDS = ["ai agent", "llm", "automation", "gpt", "claude", "openai", "anthropic", "startup", "saas", "workflow", "copilot", "rag", "vector", "embeddings", "fine-tun"];
const MED_KEYWORDS = ["machine learning", "devtools", "api", "no-code", "productivity", "integration", "platform", "enterprise", "b2b", "sales", "marketing", "growth"];

function scoreRelevance(title = "", description = "") {
  const text = `${title} ${description}`.toLowerCase();
  let score = 30;
  for (const kw of HIGH_KEYWORDS) if (text.includes(kw)) score += 12;
  for (const kw of MED_KEYWORDS) if (text.includes(kw)) score += 6;
  return Math.min(score, 100);
}

export async function POST(request) {
  const authHeader = request.headers.get("Authorization");
  const cronSecret = getCronSecret();
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = await fetchAll();
  const scored = raw
    .map((item) => ({ ...item, relevanceScore: scoreRelevance(item.title, item.description) }))
    .filter((item) => item.relevanceScore >= 40 && item.url);

  pruneOldTrends(7);
  const { added, updated } = upsertTrends(scored);
  const stats = getTrendStats();

  return NextResponse.json({ success: true, added, updated, stats });
}

export async function GET(request) {
  return POST(request);
}
