import { NextResponse } from "next/server";
import { getGitHubRepositoryAccess } from "@/lib/githubAppAuth";
import { repurposeBlogPost } from "@/lib/socialRepurpose";
import { createSocialDraft } from "@/lib/socialDraftStore";
import { publishVariants } from "@/lib/socialPublish";
import { markSlugsPublished } from "@/lib/publishedSlugsStore";

export const maxDuration = 60;

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const AI_KEYWORDS = [
  "ai", "artificial intelligence", "machine learning", "llm", "gpt", "claude",
  "agent", "neural", "reasoning", "automation", "workflow", "no-code", "openai",
  "anthropic", "mistral", "gemini", "chatgpt", "copilot", "rag", "vector",
  "embedding", "fine-tun", "prompt", "autonomous",
];
const STARTUP_KEYWORDS = [
  "startup", "funding", "seed", "series a", "launch", "yc", "saas", "growth",
  "product", "platform",
];
const DEVTOOLS_KEYWORDS = [
  "framework", "library", "sdk", "api", "open source", "cli", "developer",
  "tool", "integration", "data pipeline", "deploy",
];

function getCronSecret() {
  return process.env.CRON_SECRET || process.env.SOCIAL_AGENT_CRON_SECRET || "";
}

function getGitHubConfig() {
  return {
    owner: process.env.GITHUB_REPO_OWNER || "burchdad",
    repo: process.env.GITHUB_REPO_NAME || "ghostaisolutions",
    branch: process.env.GITHUB_TARGET_BRANCH || "main",
  };
}

function scoreStory(story) {
  const text = `${story.title} ${story.description}`.toLowerCase();
  let score = 0;
  AI_KEYWORDS.forEach((k) => {
    if (text.includes(k)) score += 3;
  });
  STARTUP_KEYWORDS.forEach((k) => {
    if (text.includes(k)) score += 1;
  });
  DEVTOOLS_KEYWORDS.forEach((k) => {
    if (text.includes(k)) score += 1;
  });
  return score;
}

function filterAndRank(stories) {
  const seen = new Set();
  const unique = stories.filter((s) => {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  return unique
    .map((s) => ({ ...s, relevanceScore: scoreStory(s) }))
    .filter((s) => s.relevanceScore >= 3)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 6);
}

async function fetchHackerNews() {
  try {
    const res = await fetch("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=20", {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HN API ${res.status}`);
    const data = await res.json();
    return (data.hits || []).map((h) => ({
      title: h.title || "",
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      source: "HackerNews",
      description: h.title || "",
      date: new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

async function fetchGitHubTrending() {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 2);
    const sinceStr = since.toISOString().slice(0, 10);

    const res = await fetch(
      `https://api.github.com/search/repositories?q=topic:ai+created:>${sinceStr}&sort=stars&order=desc&per_page=10`,
      {
        headers: { Accept: "application/vnd.github+json" },
        cache: "no-store",
      }
    );

    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    return (data.items || []).map((r) => ({
      title: r.full_name,
      url: r.html_url,
      source: "GitHub Trending",
      description: r.description || `New AI project with ${r.stargazers_count} stars`,
      date: new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

async function fetchDevTo() {
  try {
    const res = await fetch("https://dev.to/api/articles?state=fresh&per_page=15&tags=ai,automation,devtools", {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Dev.to API ${res.status}`);
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((a) => ({
      title: a.title || "",
      url: a.url || "",
      source: "Dev.to",
      description: a.description || a.title || "",
      date: a.published_at || new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

async function generateBlogPost(stories) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const storySummaries = stories
    .map(
      (s, i) =>
        `${i + 1}. \"${s.title}\" (${s.source})\n   ${String(s.description || "").slice(0, 250)}\n   URL: ${s.url}`
    )
    .join("\n\n");

  const systemPrompt = `You are the content director for Ghost AI Solutions, a boutique AI systems studio that builds custom automation platforms, AI voice agents, and data pipelines for growth-stage B2B operators.

Audience: COOs, RevOps leads, and growth PMs at companies with 20-200 employees who are outgrowing off-the-shelf SaaS.

Voice: Direct, no-jargon, ROI-focused. Occasionally dry. Never uses buzzwords like "revolutionize," "game-changing," or "unlock."`;

  const userPrompt = `Today's top tech stories:
${storySummaries}

Write a blog post that:
1. Connects these stories to real implications for the audience
2. Extracts actionable insights (what can they do THIS WEEK?)
3. Is 600-900 words total with a strong, clear title
4. Ends with a practical "this week's takeaway" callout

Return ONLY a valid JSON object (no markdown fences) with this exact structure:
{
  "title": "string — compelling, 6-12 words, not clickbait",
  "excerpt": "string — 2 sentences describing what the reader will learn",
  "category": "one of: ai-agents | automation | tools | strategy",
  "tags": ["string", "string", "string"],
  "sections": [
    { "type": "p", "text": "..." },
    { "type": "h2", "text": "..." },
    { "type": "p", "text": "..." },
    { "type": "ul", "items": ["...", "...", "..."] },
    { "type": "callout", "text": "This week's takeaway — 1-2 actionable sentences" }
  ]
}

Allowed section types: "p", "h2", "ul", "callout".
Aim for 10-14 sections total.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.72,
      response_format: { type: "json_object" },
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${err}`);
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error("Empty response from OpenAI");

  return JSON.parse(raw);
}

async function listAutoPostFiles(cfg, authToken) {
  const res = await fetch(
    `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/content/auto-posts?ref=${cfg.branch}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${authToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    }
  );

  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`GitHub list contents failed (${res.status})`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data.map((item) => item.name) : [];
}

async function createAutoPostFile(cfg, authToken, slug, contentJson) {
  const filePath = `content/auto-posts/${slug}.json`;
  const encoded = Buffer.from(contentJson, "utf8").toString("base64");

  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${filePath}`, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      message: `blog: auto-generate post for ${new Date().toISOString().slice(0, 10)}`,
      content: encoded,
      branch: cfg.branch,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub create file failed (${res.status}): ${err}`);
  }

  return res.json();
}

async function moderateAndPublish(post) {
  const content = (post.sections || [])
    .map((s) => (typeof s === "string" ? s : s.text || (Array.isArray(s.items) ? s.items.join(" ") : "")))
    .join(" ");

  const repurposed = await repurposeBlogPost({
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt || "",
    content,
  });

  const variants = repurposed.variants;
  const moderation = repurposed.moderation;

  if (!variants) {
    return { success: false, stage: "repurpose", error: "No variants returned" };
  }

  if (moderation.status !== "approved") {
    const draft = await createSocialDraft({
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt || "",
      sourceType: "content-agent-moderation",
      status: moderation.status === "blocked" ? "rejected" : "review",
      platformVariants: variants,
    });

    return { success: false, stage: "moderation", moderation, draftId: draft.id };
  }

  const publishData = await publishVariants({
    platform: "all",
    linkedinContent: variants.linkedin?.text,
    xContent: variants.x?.text,
    facebookContent: variants.facebook?.text,
  });

  const draft = await createSocialDraft({
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt || "",
    sourceType: "content-agent-audit",
    status: publishData.success ? "published" : "review",
    platformVariants: variants,
    publishResults: publishData.results,
    lastPublishedAt: publishData.success ? new Date().toISOString() : null,
  });

  return {
    success: publishData.success,
    moderation,
    draftId: draft.id,
    status: draft.status,
    results: publishData.results,
  };
}

async function run(request) {
  const authHeader = request.headers.get("Authorization");
  const cronSecret = getCronSecret();

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: "Unauthorized: Invalid or missing cron secret (CRON_SECRET or SOCIAL_AGENT_CRON_SECRET)" },
      { status: 401 }
    );
  }

  const cfg = getGitHubConfig();

  try {
    const githubAccess = await getGitHubRepositoryAccess({ owner: cfg.owner, repo: cfg.repo });
    const today = new Date().toISOString().slice(0, 10);
    const existingFiles = await listAutoPostFiles(cfg, githubAccess.token);
    const existingToday = existingFiles.find((name) => name.startsWith(today));

    if (existingToday) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: "Post already exists for today",
        existingFile: existingToday,
      });
    }

    const [hn, gh, devto] = await Promise.all([
      fetchHackerNews(),
      fetchGitHubTrending(),
      fetchDevTo(),
    ]);

    const topStories = filterAndRank([...hn, ...gh, ...devto]);
    if (!topStories.length) {
      return NextResponse.json({ success: true, skipped: true, reason: "No relevant stories found" });
    }

    const post = await generateBlogPost(topStories);
    if (!post?.title || !Array.isArray(post.sections) || post.sections.length === 0) {
      throw new Error("OpenAI returned an incomplete post structure");
    }

    const slugBase = post.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    const slug = `${today}-${slugBase}`;

    const output = {
      slug,
      title: post.title,
      date: today,
      excerpt: post.excerpt || "",
      category: ["ai-agents", "automation", "tools", "strategy"].includes(post.category)
        ? post.category
        : "ai-agents",
      tags: Array.isArray(post.tags) ? post.tags.slice(0, 5) : [],
      sections: post.sections,
      sources: topStories.map(({ title, url, source, relevanceScore }) => ({
        title,
        url,
        source,
        relevanceScore,
      })),
      auto: true,
    };

    await createAutoPostFile(cfg, githubAccess.token, slug, JSON.stringify(output, null, 2));

    const social = await moderateAndPublish(output);
    await markSlugsPublished([slug]).catch(() => null);

    return NextResponse.json({
      success: true,
      generated: { slug, title: output.title, category: output.category },
      repo: { owner: cfg.owner, name: cfg.repo, branch: cfg.branch },
      githubAuth: { mode: githubAccess.mode, installationId: githubAccess.installationId, expiresAt: githubAccess.expiresAt },
      social,
      storiesAnalyzed: topStories.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Content trigger failed", details: err?.message || String(err) },
      { status: 500 }
    );
  }
}

export async function GET(request) {
  return run(request);
}

export async function POST(request) {
  return run(request);
}
