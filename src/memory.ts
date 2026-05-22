import fs from "fs";
import path from "path";

const FORMAT_VERSION = 1;
const MEMORY_FILENAME = "AGENTS.md";
const SESSION_HEADER_RE = /^## Session: (\d{4}-\d{2}-\d{2})$/;
const AGENT_HEADER_RE = /^### ([^-][^\n]*?) — ([^\n]+)$/;
const MESSAGE_RE = /^\*\*([^*]+)\*\* — (.+)$/;
const TAG_RE = /(^|\s)(#(?:decision|blocker|todo))(?=\s|$|[.,;:!?])/gi;
const DECISION_HINT_RE =
  /\b(use|used|choose|chosen|decide|decided|ship|shipped|implement|implemented|will use|going with)\b/i;

export type MemoryTag = "decision" | "blocker" | "todo";

type MemoryEntry = {
  sessionDate: string;
  agent: string;
  persona: string;
  speaker: string;
  message: string;
  tags: MemoryTag[];
};

type SessionResult = {
  status: "created" | "exists";
  session: string;
};

type AppendResult = {
  status: "appended";
  speaker: string;
  agent: string;
  persona: string;
};

type SearchResult = {
  score: number;
  sessionDate: string;
  agent: string;
  persona: string;
  speaker: string;
  message: string;
  tags: MemoryTag[];
};

type SessionSummary = {
  sessionDate: string;
  messageCount: number;
  participants: string[];
  decisions: string[];
  blockers: string[];
  todos: string[];
  highlights: string[];
};

function getMemoryPath(repoPath: string): string {
  return path.join(repoPath, MEMORY_FILENAME);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function assertRepoPath(repoPath: string): void {
  if (!path.isAbsolute(repoPath)) {
    throw new Error("repo_path must be an absolute path");
  }
}

function buildHeader(repoPath: string): string {
  return [
    "---",
    `format: ${FORMAT_VERSION}`,
    `project: ${path.basename(repoPath)}`,
    `created: ${today()}`,
    "---",
    "",
    "# Agent Memory",
    "",
  ].join("\n");
}

function ensureFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buildHeader(path.dirname(filePath)), "utf8");
  }
}

function extractFormatVersion(content: string): number | null {
  const match = content.match(/^---\nformat: (\d+)\n/m);
  return match ? Number(match[1]) : null;
}

function readFile(filePath: string): string {
  ensureFile(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const formatVersion = extractFormatVersion(content);

  if (formatVersion !== null && formatVersion > FORMAT_VERSION) {
    throw new Error(
      `AGENTS.md uses format ${formatVersion}, but this server only supports ${FORMAT_VERSION}`
    );
  }

  return content;
}

function normalizeLabel(value: unknown, fieldName: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${fieldName} cannot be empty`);
  }
  if (normalized.includes("\n")) {
    throw new Error(`${fieldName} must be single-line text`);
  }
  return normalized;
}

function normalizeMessage(message: unknown): string {
  const normalized = String(message ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");

  if (!normalized) {
    throw new Error("message cannot be empty");
  }

  return normalized;
}

function appendText(filePath: string, text: string): void {
  fs.appendFileSync(filePath, text, "utf8");
}

function extractTags(message: string): MemoryTag[] {
  const tags = new Set<MemoryTag>();

  for (const match of message.matchAll(TAG_RE)) {
    const tag = match[2]?.slice(1).toLowerCase() as MemoryTag | undefined;
    if (tag === "decision" || tag === "blocker" || tag === "todo") {
      tags.add(tag);
    }
  }

  return [...tags];
}

function isDecisionEntry(entry: MemoryEntry): boolean {
  return entry.tags.includes("decision") || DECISION_HINT_RE.test(entry.message);
}

function normalizeSearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function scoreEntry(entry: MemoryEntry, queryTerms: string[]): number {
  if (queryTerms.length === 0) {
    return 0;
  }

  const messageLower = entry.message.toLowerCase();
  const haystack = [
    entry.sessionDate,
    entry.agent,
    entry.persona,
    entry.speaker,
    entry.message,
    ...entry.tags.map((tag) => `#${tag}`),
  ].join(" ").toLowerCase();

  let score = 0;

  for (const term of queryTerms) {
    if (haystack.includes(term)) {
      score += 1;
    }
    if (messageLower.includes(term)) {
      score += 2;
    }
    if (entry.tags.some((tag) => `#${tag}` === term)) {
      score += 3;
    }
  }

  return score;
}

function parseSessionDates(content: string): string[] {
  return [...content.matchAll(/^## Session: (\d{4}-\d{2}-\d{2})$/gm)].map((match) => match[1]);
}

function parseEntries(content: string): MemoryEntry[] {
  const lines = content.split("\n");
  const entries: MemoryEntry[] = [];
  let sessionDate: string | null = null;
  let agent: string | null = null;
  let persona: string | null = null;

  for (const line of lines) {
    const sessionMatch = line.match(SESSION_HEADER_RE);
    if (sessionMatch) {
      sessionDate = sessionMatch[1];
      agent = null;
      persona = null;
      continue;
    }

    const agentMatch = line.match(AGENT_HEADER_RE);
    if (agentMatch) {
      agent = agentMatch[1].trim();
      persona = agentMatch[2].trim();
      continue;
    }

    const messageMatch = line.match(MESSAGE_RE);
    if (messageMatch && sessionDate && agent && persona) {
      const message = messageMatch[2].trim();
      entries.push({
        sessionDate,
        agent,
        persona,
        speaker: messageMatch[1].trim(),
        message,
        tags: extractTags(message),
      });
    }
  }

  return entries;
}

function ensureSessionAndSection(content: string, agent: string, persona: string): string {
  const activeDate = today();
  const sessionHeader = `## Session: ${activeDate}`;
  const agentHeader = `### ${agent} — ${persona}`;
  let addition = "";

  const trimmed = content.trimEnd();
  if (!trimmed.includes(sessionHeader)) {
    addition += `\n## Session: ${activeDate}\n\n`;
  } else if (!trimmed.endsWith(agentHeader)) {
    addition += "\n";
  }

  if (!trimmed.endsWith(agentHeader)) {
    addition += `${agentHeader}\n`;
  }

  return addition;
}

export function startSession(repoPath: string, agent: string, persona: string): SessionResult {
  assertRepoPath(repoPath);
  const normalizedAgent = normalizeLabel(agent, "agent");
  const normalizedPersona = normalizeLabel(persona, "persona");
  const filePath = getMemoryPath(repoPath);
  const content = readFile(filePath);
  const addition = ensureSessionAndSection(content, normalizedAgent, normalizedPersona);

  if (!addition) {
    return { status: "exists", session: `${today()} — ${normalizedAgent}/${normalizedPersona}` };
  }

  appendText(filePath, addition);
  return { status: "created", session: `${today()} — ${normalizedAgent}/${normalizedPersona}` };
}

export function appendMessage(
  repoPath: string,
  agent: string,
  persona: string,
  speaker: string,
  message: string
): AppendResult {
  assertRepoPath(repoPath);
  const normalizedAgent = normalizeLabel(agent, "agent");
  const normalizedPersona = normalizeLabel(persona, "persona");
  const normalizedSpeaker = normalizeLabel(speaker, "speaker");
  const normalizedMessage = normalizeMessage(message);
  const filePath = getMemoryPath(repoPath);
  const content = readFile(filePath);
  const addition = ensureSessionAndSection(content, normalizedAgent, normalizedPersona);

  if (addition) {
    appendText(filePath, addition);
  }

  appendText(filePath, `**${normalizedSpeaker}** — ${normalizedMessage}\n`);
  return {
    status: "appended",
    speaker: normalizedSpeaker,
    agent: normalizedAgent,
    persona: normalizedPersona,
  };
}

export function readMemory(
  repoPath: string,
  filterAgent?: string,
  filterPersona?: string
): string {
  assertRepoPath(repoPath);
  const filePath = getMemoryPath(repoPath);
  const content = readFile(filePath);

  if (!filterAgent && !filterPersona) {
    return content;
  }

  const entries = parseEntries(content).filter((entry) => {
    if (filterAgent && entry.agent !== filterAgent) {
      return false;
    }
    if (filterPersona && entry.persona !== filterPersona) {
      return false;
    }
    return true;
  });

  return entries
    .map(
      (entry) =>
        `[${entry.sessionDate}] ${entry.agent}/${entry.persona} ${entry.speaker}: ${entry.message}`
    )
    .join("\n");
}

export function getContext(repoPath: string, lastN = 20): string {
  assertRepoPath(repoPath);
  if (!Number.isInteger(lastN) || lastN <= 0) {
    throw new Error("last_n must be a positive integer");
  }

  const filePath = getMemoryPath(repoPath);
  const content = readFile(filePath);
  const entries = parseEntries(content).slice(-lastN);

  return entries
    .map(
      (entry) =>
        `[${entry.sessionDate}] ${entry.agent}/${entry.persona} ${entry.speaker}: ${entry.message}`
    )
    .join("\n");
}

export function searchMemory(
  repoPath: string,
  query: string,
  limit = 10,
  filterAgent?: string,
  filterPersona?: string,
  filterTag?: MemoryTag
): SearchResult[] {
  assertRepoPath(repoPath);
  const normalizedQuery = normalizeMessage(query);

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }

  const filePath = getMemoryPath(repoPath);
  const content = readFile(filePath);
  const queryTerms = normalizeSearchTerms(normalizedQuery);

  return parseEntries(content)
    .filter((entry) => {
      if (filterAgent && entry.agent !== filterAgent) {
        return false;
      }
      if (filterPersona && entry.persona !== filterPersona) {
        return false;
      }
      if (filterTag && !entry.tags.includes(filterTag)) {
        return false;
      }
      return true;
    })
    .map((entry) => ({ ...entry, score: scoreEntry(entry, queryTerms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function getDecisions(
  repoPath: string,
  sessionDate?: string,
  filterAgent?: string,
  filterPersona?: string
): string[] {
  assertRepoPath(repoPath);
  const filePath = getMemoryPath(repoPath);
  const content = readFile(filePath);

  return parseEntries(content)
    .filter((entry) => {
      if (sessionDate && entry.sessionDate !== sessionDate) {
        return false;
      }
      if (filterAgent && entry.agent !== filterAgent) {
        return false;
      }
      if (filterPersona && entry.persona !== filterPersona) {
        return false;
      }
      return isDecisionEntry(entry);
    })
    .map(
      (entry) =>
        `[${entry.sessionDate}] ${entry.agent}/${entry.persona} ${entry.speaker}: ${entry.message}`
    );
}

export function summarizeSession(repoPath: string, sessionDate?: string): SessionSummary {
  assertRepoPath(repoPath);
  const filePath = getMemoryPath(repoPath);
  const content = readFile(filePath);
  const availableSessionDates = parseSessionDates(content);
  const resolvedSessionDate = sessionDate ?? availableSessionDates.at(-1);

  if (!resolvedSessionDate) {
    throw new Error("No sessions found in AGENTS.md");
  }

  const entries = parseEntries(content).filter((entry) => entry.sessionDate === resolvedSessionDate);

  if (entries.length === 0) {
    throw new Error(`No messages found for session ${resolvedSessionDate}`);
  }

  const participants = [...new Set(entries.map((entry) => `${entry.agent}/${entry.persona}`))];
  const decisions = entries.filter(isDecisionEntry).map((entry) => entry.message);
  const blockers = entries
    .filter((entry) => entry.tags.includes("blocker"))
    .map((entry) => entry.message);
  const todos = entries.filter((entry) => entry.tags.includes("todo")).map((entry) => entry.message);
  const highlights = entries
    .filter((entry) => entry.tags.length > 0 || isDecisionEntry(entry))
    .slice(0, 5)
    .map((entry) => `[${entry.agent}/${entry.persona}] ${entry.message}`);

  return {
    sessionDate: resolvedSessionDate,
    messageCount: entries.length,
    participants,
    decisions,
    blockers,
    todos,
    highlights,
  };
}
