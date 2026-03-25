/**
 * Robust YAML frontmatter parser for Obsidian markdown files.
 *
 * Fixes Python's fragile parser (lines 1327-1401) which:
 * - Split arrays on commas (breaking values with commas inside)
 * - Had no multiline support
 * - Had no quote-awareness
 */

import type { FrontmatterData, FrontmatterValue, ParsedMarkdown } from "../types.js";

/**
 * Split a YAML inline array string into items, respecting quotes.
 *
 * Example: `[item1, "item, with comma", 'another']`
 * Returns: `["item1", "item, with comma", "another"]`
 */
function splitInlineArray(raw: string): string[] {
  const inner = raw.slice(1, -1); // Remove [ and ]
  const items: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ",") {
      const trimmed = current.trim();
      if (trimmed) items.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed) items.push(trimmed);

  return items;
}

/**
 * Parse a single YAML frontmatter value.
 */
function parseValue(raw: string): FrontmatterValue {
  const trimmed = raw.trim();

  // Inline array: [item1, item2, ...]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitInlineArray(trimmed);
  }

  // Boolean
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;

  // Quoted string — strip quotes
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  // Plain string
  return trimmed;
}

/**
 * Parse YAML-like frontmatter from markdown content.
 *
 * Handles:
 * - Inline arrays with quote-aware comma splitting
 * - YAML list syntax (- item per line)
 * - Boolean values (true/false)
 * - Quoted strings (single/double)
 * - Nested colons in values (splits on first : only)
 * - Empty/malformed frontmatter (returns empty dict)
 */
export function parseFrontmatter(content: string): ParsedMarkdown {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  // Find the closing ---
  const secondDash = content.indexOf("---", 3);
  if (secondDash === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmBlock = content.slice(3, secondDash).trim();
  const body = content.slice(secondDash + 3);
  const fm: FrontmatterData = {};

  const lines = fmBlock.split("\n");
  let currentKey: string | null = null;
  let currentListItems: string[] | null = null;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // YAML list continuation: "  - item"
    if (currentKey && currentListItems !== null && /^\s+-\s+/.test(line)) {
      const item = trimmedLine.slice(2).trim(); // Remove "- "
      currentListItems.push(item.replace(/^['"]|['"]$/g, ""));
      continue;
    }

    // Flush pending list
    if (currentKey && currentListItems !== null) {
      fm[currentKey] = currentListItems;
      currentKey = null;
      currentListItems = null;
    }

    // Skip empty lines and lines without colons
    if (!trimmedLine || !trimmedLine.includes(":")) {
      continue;
    }

    const colonIdx = trimmedLine.indexOf(":");
    const key = trimmedLine.slice(0, colonIdx).trim();
    const rawValue = trimmedLine.slice(colonIdx + 1).trim();

    if (!key) continue;

    // Empty value — might be start of a YAML list
    if (!rawValue) {
      currentKey = key;
      currentListItems = [];
      continue;
    }

    fm[key] = parseValue(rawValue);
  }

  // Flush final pending list
  if (currentKey && currentListItems !== null) {
    fm[currentKey] = currentListItems;
  }

  return { frontmatter: fm, body };
}

/**
 * Update a single frontmatter field value.
 * If the field doesn't exist, it's appended.
 */
export function updateFrontmatterField(content: string, key: string, value: string): string {
  if (!content.startsWith("---")) {
    return content;
  }

  const secondDash = content.indexOf("---", 3);
  if (secondDash === -1) {
    return content;
  }

  const fmBlock = content.slice(3, secondDash).trim();
  const rest = content.slice(secondDash);
  const lines = fmBlock.split("\n");
  let updated = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const lineKey = trimmed.slice(0, colonIdx).trim();
    if (lineKey === key) {
      lines[i] = `${key}: ${value}`;
      updated = true;
      break;
    }
  }

  if (!updated) {
    lines.push(`${key}: ${value}`);
  }

  return `---\n${lines.join("\n")}\n${rest}`;
}

/**
 * Add a value to a frontmatter list field (inline array format).
 * If the field doesn't exist, creates it as [value].
 * If the value already exists, does nothing.
 */
export function updateFrontmatterList(content: string, key: string, value: string): string {
  if (!content.startsWith("---")) {
    return content;
  }

  const secondDash = content.indexOf("---", 3);
  if (secondDash === -1) {
    return content;
  }

  const fmBlock = content.slice(3, secondDash).trim();
  const rest = content.slice(secondDash);
  const lines = fmBlock.split("\n");
  let updated = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const lineKey = trimmed.slice(0, colonIdx).trim();
    if (lineKey === key) {
      const rawValue = trimmed.slice(colonIdx + 1).trim();
      if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
        const items = splitInlineArray(rawValue);
        if (!items.includes(value)) {
          items.push(value);
        }
        lines[i] = `${key}: [${items.join(", ")}]`;
      }
      updated = true;
      break;
    }
  }

  if (!updated) {
    lines.push(`${key}: [${value}]`);
  }

  return `---\n${lines.join("\n")}\n${rest}`;
}

/**
 * Serialize a frontmatter data object back to YAML frontmatter string.
 */
export function serializeFrontmatter(fm: FrontmatterData): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else if (typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  return `---\n${lines.join("\n")}\n---`;
}
