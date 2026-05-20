export type ContextSection = {
  label: string;
  content: string;
  priority: number;
  maxChars?: number;
  maxTokens?: number;
};

export type CompressionStats = {
  estimatedTokens: number;
  trimmedSections: string[];
  includedSections: string[];
  hardCapTokens: number;
};

function compactWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function compactText(text: string, maxChars = 420) {
  const clean = compactWhitespace(text);
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

export function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function compressContextSections(sections: ContextSection[], maxChars = 3600) {
  const ordered = sections
    .filter((section) => section.content.trim().length > 0)
    .sort((a, b) => b.priority - a.priority);

  const lines: string[] = [];
  let used = 0;
  for (const section of ordered) {
    const content = compactText(section.content, section.maxChars ?? 520);
    const line = `${section.label}: ${content}`;
    if (used + line.length + 1 > maxChars) continue;
    lines.push(line);
    used += line.length + 1;
  }

  return lines.join("\n");
}

export function compressContextSectionsWithBudget(sections: ContextSection[], hardCapTokens = 1800) {
  const ordered = sections
    .filter((section) => section.content.trim().length > 0)
    .sort((a, b) => b.priority - a.priority);

  const lines: string[] = [];
  const includedSections: string[] = [];
  const trimmedSections: string[] = [];
  let usedTokens = 0;

  for (const section of ordered) {
    const sectionTokenCap = section.maxTokens ?? Math.ceil((section.maxChars ?? 520) / 4);
    const content = compactText(section.content, sectionTokenCap * 4);
    const line = `${section.label}: ${content}`;
    const lineTokens = estimateTokens(line);
    if (usedTokens + lineTokens > hardCapTokens) {
      trimmedSections.push(section.label);
      continue;
    }
    lines.push(line);
    includedSections.push(section.label);
    usedTokens += lineTokens;
  }

  return {
    text: lines.join("\n"),
    stats: {
      estimatedTokens: usedTokens,
      trimmedSections,
      includedSections,
      hardCapTokens
    } satisfies CompressionStats
  };
}

export function summarizeTurnsForPrompt(turns: Array<{ role: string; content: string }>, limit = 10) {
  return turns
    .slice(-limit)
    .map((turn) => `${turn.role === "assistant" ? "AURA" : "User"}: ${compactText(turn.content, 260)}`)
    .join("\n");
}
