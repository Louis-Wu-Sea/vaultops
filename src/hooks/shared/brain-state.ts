/**
 * VaultOps Brain — shared state module for autonomous hook coordination.
 *
 * All hooks share session state through a JSON file on disk.
 * Provides state management, intent classification, evidence parsing,
 * predictive brain, and learning event logging.
 *
 * Ported from Python brain_state.py (1,007 LOC).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ── Session state path ──────────────────────────────────────────────────

export function statePath(projectPath: string): string {
  const h = crypto.createHash("md5").update(projectPath).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `vaultops-brain-${h}.json`);
}

export interface BrainState {
  session_start: string;
  phase: string;
  active_task_id: string | null;
  task_auto_created: boolean;
  intent: string | null;
  user_prompt_summary: string;
  files_edited: Array<{ path: string; timestamp: string }>;
  files_created: Array<{ path: string; timestamp: string }>;
  bash_commands_summary: Array<{ summary: string; timestamp: string }>;
  tests_run: boolean;
  tests_passed: boolean | null;
  commits: Array<{ sha: string; message: string }>;
  docs_touched: string[];
  suppressed: boolean;
  prompt_count: number;
  intent_match_layer: string | null;
  original_priority: string | null;
  enrichment_count: number;
  risk_warned: boolean;
  hotspot_warned: string[];
  meeting_warned?: boolean;
}

const DEFAULT_STATE: BrainState = {
  session_start: "",
  phase: "idle",
  active_task_id: null,
  task_auto_created: false,
  intent: null,
  user_prompt_summary: "",
  files_edited: [],
  files_created: [],
  bash_commands_summary: [],
  tests_run: false,
  tests_passed: null,
  commits: [],
  docs_touched: [],
  suppressed: false,
  prompt_count: 0,
  intent_match_layer: null,
  original_priority: null,
  enrichment_count: 0,
  risk_warned: false,
  hotspot_warned: [],
};

export function getDefaultState(): BrainState {
  return { ...DEFAULT_STATE, files_edited: [], files_created: [], bash_commands_summary: [], commits: [], docs_touched: [], hotspot_warned: [] };
}

/** Known keys in BrainState — used to strip unknown properties on deserialization. */
const BRAIN_STATE_KEYS = new Set<string>([
  "session_start", "phase", "active_task_id", "task_auto_created", "intent",
  "user_prompt_summary", "files_edited", "files_created", "bash_commands_summary",
  "tests_run", "tests_passed", "commits", "docs_touched", "suppressed", "prompt_count",
  "intent_match_layer", "original_priority", "enrichment_count", "risk_warned",
  "hotspot_warned", "meeting_warned",
]);

export function loadState(projectPath: string): BrainState {
  const fp = statePath(projectPath);
  try {
    const raw = fs.readFileSync(fp, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return getDefaultState();
    }
    // Strip unknown keys to prevent injection of arbitrary properties
    const safe: Record<string, unknown> = {};
    for (const key of BRAIN_STATE_KEYS) {
      if (key in data) safe[key] = data[key];
    }
    return { ...getDefaultState(), ...safe } as BrainState;
  } catch {
    return getDefaultState();
  }
}

export function saveState(projectPath: string, state: BrainState): void {
  const fp = statePath(projectPath);
  const tmp = fp + `.${process.pid}.tmp`;
  try {
    // Use PID-scoped temp file to avoid collisions from parallel hooks
    fs.writeFileSync(tmp, JSON.stringify(state, null, 0), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, fp);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function cleanupState(projectPath: string): void {
  try { fs.unlinkSync(statePath(projectPath)); } catch { /* ignore */ }
}

export function isVaultopsProject(projectPath: string): boolean {
  try {
    return fs.statSync(path.join(projectPath, ".vaultops", "config.env")).isFile();
  } catch {
    return false;
  }
}

// ── Intent classification ───────────────────────────────────────────────

const EN_WORK_STEMS = new Set([
  "add", "fix", "impl", "creat", "updat", "refact", "build",
  "remov", "delet", "migrat", "deploy", "config", "optim",
  "test", "writ", "instal", "setup", "chang", "modif",
  "replac", "mov", "renam", "extract", "split", "merg", "upgrad",
  "downgrad", "enabl", "disabl", "connect", "integrat", "debug",
  "rewrit", "redesign", "patch", "resolv", "handl", "convert",
  "scaffold", "bootstrap", "generat", "compil", "bundl",
]);

const RU_WORK_STEMS = new Set([
  "добав", "исправ", "созда", "обнов", "удал", "настро",
  "сделай", "сделат", "сделал", "поправ", "перепис", "переделa",
  "поменя", "убер", "почин", "разверн", "накат", "раскат",
  "залей", "запуст", "подключ", "отключ", "перенес", "вынес",
  "разбе", "объедин", "реализ", "оптимиз", "рефактор", "отрефакт",
  "дебаг", "протест", "задеплой",
]);

const UK_WORK_STEMS = new Set([
  "додай", "додат", "виправ", "створ", "зроб", "оновл", "оптиміз",
  "налашт", "видал", "перепис", "замін", "перенес", "підключ",
  "відключ", "розгорн", "запуст", "рефактор", "реалізув", "протест",
]);

const HYBRID_STEMS = new Set([
  "фикс", "деплой", "пуш", "пул", "мёрж", "мерж", "коммит",
  "ревью", "билд", "хендл", "чекаут", "ребейз", "хотфикс",
  "роллбек", "роллбэк", "рестарт", "апдейт", "апгрейд",
]);

const ALL_WORK_STEMS = new Set([...EN_WORK_STEMS, ...RU_WORK_STEMS, ...UK_WORK_STEMS, ...HYBRID_STEMS]);

// ── Agent command detection constants ────────────────────────────────────
// These are operations the user asks the AGENT to perform, not work items to track.

const GIT_NOUNS = new Set([
  "коммит", "commit", "пуш", "push", "пул", "pull", "мёрж", "мерж", "merge",
  "ребейз", "rebase", "чекаут", "checkout", "бранч", "branch", "стеш", "stash",
  "черри", "cherry", "тег", "tag", "фетч", "fetch", "клон", "clone",
]);

const TEST_NOUNS = new Set([
  "тест", "test", "линт", "lint", "чек", "check", "билд", "build",
  "компил", "compile", "формат", "format",
]);

const SESSION_PHRASES = new Set([
  "ты закончил", "ты готов", "ты сделал", "ты всё", "ты все",
  "are you done", "are you finished", "you done", "you finished",
  "готово", "всё готово", "все готово",
  "давай дальше", "go ahead", "поехали", "начинай",
]);

const AGENT_ACTION_STEMS = new Set([
  "сделай", "делай", "давай", "запусти", "покажи", "открой", "закрой",
  "выполни", "глянь", "посмотри", "скажи",
  "run", "execute", "do", "show", "open", "close", "look",
  "start", "stop", "print", "display",
]);

const FUNCTION_WORDS = new Set([
  "и", "в", "на", "с", "по", "к", "у", "за", "из", "от", "до", "о", "об",
  "the", "a", "an", "it", "to", "for", "of", "in", "on", "at", "is", "are",
  "this", "that", "его", "её", "их", "мне", "мой", "эту", "это", "этот",
  "ещё", "еще", "уже", "тут", "там", "все", "всё", "ок", "ok", "да", "нет",
]);

function isGitNoun(words: Set<string>): boolean {
  for (const word of words) {
    for (const noun of [...GIT_NOUNS, ...TEST_NOUNS]) {
      if (word === noun || word.startsWith(noun)) return true;
    }
  }
  return false;
}

function extractDomainNouns(words: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const w of words) {
    if (w.length < 2) continue;
    if (FUNCTION_WORDS.has(w)) continue;
    if ([...AGENT_ACTION_STEMS].some(s => w.startsWith(s))) continue;
    if ([...GIT_NOUNS, ...TEST_NOUNS].some(n => w === n || w.startsWith(n))) continue;
    result.add(w);
  }
  return result;
}

function isAgentCommand(promptLower: string, words: Set<string>): string | null {
  for (const phrase of SESSION_PHRASES) {
    if (promptLower.includes(phrase)) return "session";
  }

  const domainNouns = extractDomainNouns(words);
  const hasGit = [...words].some(w => [...GIT_NOUNS].some(n => w === n || w.startsWith(n)));
  const hasTest = [...words].some(w => [...TEST_NOUNS].some(n => w === n || w.startsWith(n)));

  const firstWord = promptLower.split(/\s+/)[0] ?? "";
  const isAgentVerb = [...AGENT_ACTION_STEMS].some(s => firstWord.startsWith(s));

  if (isAgentVerb && hasGit) return "git";
  if (isAgentVerb && hasTest) return "test";
  if (isAgentVerb && domainNouns.size === 0 && words.size <= 3) return "generic";

  if (promptLower.length < 40 && domainNouns.size === 0 && (hasGit || hasTest)) {
    return hasGit ? "git" : "test";
  }

  return null;
}

// Transliteration map
const TRANSLIT: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
  'і': 'i', 'ї': 'yi', 'є': 'ye', 'ґ': 'g',
};

const SLAVIC_PREFIXES = ["пере", "за", "по", "на", "от", "об", "про", "вы", "при", "раз", "під", "від", "роз", "пре"];
const SLAVIC_SUFFIXES = ["ить", "ать", "ять", "уть", "нуть", "ти", "ся", "сь", "ни", "ну", "ай", "уй", "и"];

function transliterate(word: string): string {
  return [...word].map(c => TRANSLIT[c] ?? c).join("");
}

function decomposeMixed(word: string): string | null {
  if (word.length < 4) return null;
  let core = word;
  for (const pfx of SLAVIC_PREFIXES) {
    if (word.startsWith(pfx) && word.length > pfx.length + 2) {
      core = word.slice(pfx.length);
      break;
    }
  }
  for (const sfx of SLAVIC_SUFFIXES) {
    if (core.endsWith(sfx) && core.length > sfx.length + 2) {
      core = core.slice(0, -sfx.length);
      break;
    }
  }
  return (core !== word && core.length >= 3) ? core : null;
}

function fuzzyMatch(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  const matches = [...a].filter((c, i) => i < n && c === b[i]).length;
  return (2 * matches) / (m + n);
}

function fuzzyStemMatch(word: string, stems: Set<string>, threshold = 0.7): boolean {
  for (const stem of stems) {
    const prefix = word.slice(0, stem.length + 2);
    if (fuzzyMatch(prefix, stem) >= threshold) return true;
  }
  return false;
}

function hasWorkStem(words: Set<string>): [boolean, string | null] {
  // Layer 1: exact prefix
  for (const word of words) {
    for (const stem of ALL_WORK_STEMS) {
      if (word.startsWith(stem)) return [true, "stem"];
    }
  }
  // Layer 2: decompose + transliterate
  for (const word of words) {
    const root = decomposeMixed(word);
    if (root) {
      for (const stem of HYBRID_STEMS) {
        if (root.startsWith(stem)) return [true, "transliterate"];
      }
      const tr = transliterate(root);
      for (const stem of EN_WORK_STEMS) {
        if (tr.startsWith(stem) || stem.startsWith(tr)) return [true, "transliterate"];
      }
    }
  }
  // Layer 3: fuzzy
  const FUZZY_SKIP = new Set([
    "делает", "делать", "делал", "делаю", "робить", "робит",
    "модуль", "работа", "работает", "файл", "файлы", "проект",
    ...GIT_NOUNS, ...TEST_NOUNS, // never fuzzy-match agent command nouns
  ]);
  for (const word of words) {
    if (word.length >= 3 && word.length <= 14 && !FUZZY_SKIP.has(word)) {
      if (fuzzyStemMatch(word, ALL_WORK_STEMS, 0.82)) return [true, "fuzzy"];
    }
  }
  return [false, null];
}

// Implicit intent patterns
const IMPLICIT_WORK_PATTERNS: Array<[RegExp, string]> = [
  [/(?:сломал|поломал|\bупал\b|не работает|не запускается|broken|doesn't work|не робить|не працює|падает|крашит)/i, "bugfix"],
  [/(?:ужас\w*|кошмар|говнокод|terrible|awful|messy|грязн|бардак|хаос|legacy)/i, "refactor"],
  [/(?:медленн|тормоз|slow|laggy|повільн|\bдолго\b|долго грузит|висит)/i, "refactor"],
  [/нужн[оа]?\s+(?:бы\s+)?(?:сделать|добавить|написать|реализовать)/i, "new_feature"],
  [/треба\s+(?:зробити|додати|написати|реалізувати)/i, "new_feature"],
  [/(?:хорошо бы|было бы неплохо|стоит|надо бы|варто було б)/i, "new_feature"],
];

function hasImplicitIntent(promptLower: string): string | null {
  for (const [pattern, intentType] of IMPLICIT_WORK_PATTERNS) {
    if (pattern.test(promptLower)) return intentType;
  }
  return null;
}

// Question detection
const EN_QUESTION_STARTS = new Set([
  "what", "how", "why", "where", "when", "which", "who",
  "is", "are", "can", "could", "would", "should", "does", "do",
  "explain", "tell", "describe", "show", "list",
]);
const RU_QUESTION_STEMS = new Set([
  "что", "как", "почему", "зачем", "где", "когда", "кто", "какой", "какая", "какие",
  "объясн", "расскаж", "покаж", "опиши", "перечисл",
]);
const UK_QUESTION_STEMS = new Set([
  "що", "як", "чому", "навіщо", "де", "коли", "хто", "який", "яка", "які",
  "поясн", "розкаж", "покаж", "опиш",
]);

function isQuestionWord(word: string): boolean {
  if (EN_QUESTION_STARTS.has(word)) return true;
  for (const stem of RU_QUESTION_STEMS) { if (word.startsWith(stem)) return true; }
  for (const stem of UK_QUESTION_STEMS) { if (word.startsWith(stem)) return true; }
  return false;
}

export const SUPPRESS_PHRASES = [
  "don't track", "dont track", "no task", "skip tracking", "skip vaultops", "just a question",
  "не трекай", "не трэкай", "без задачи", "без таски", "не логируй",
  "не відслідковуй", "без задачі", "не трекай", "без таски",
];

const CONTINUATION_STEMS = new Set([
  "now", "also", "next", "then", "continu", "and",
  "теперь", "тепер", "ещ", "еще", "дале", "потом", "продолж",
  "також", "далі", "тепер", "продовж",
]);

function hasContinuation(words: Set<string>): boolean {
  for (const word of words) {
    for (const stem of CONTINUATION_STEMS) {
      if (word.startsWith(stem)) return true;
    }
  }
  return false;
}

const EXE_PATTERN = /EXE-\d+(?:\.\d+)?/i;

function extractWords(text: string): Set<string> {
  return new Set((text.match(/[a-zA-Zа-яА-ЯіІїЇєЄґҐёЁ]+/g) ?? []).map(w => w.toLowerCase()));
}

function classifyWorkType(promptLower: string): string {
  const bugStems = new Set(["fix", "bug", "broken", "error", "crash", "исправ", "баг", "ошибк", "помилк",
    "виправ", "почин", "поправ", "фикс", "хотфикс", "сломал", "поломал", "упал", "падает", "крашит"]);
  const refactorStems = new Set(["refact", "optim", "cleanup", "simplif", "рефактор", "оптиміз", "оптимиз",
    "ужасн", "говнокод", "грязн", "тормоз", "медленн"]);
  const docStems = new Set(["document", "docs", "readme", "документ", "документац"]);
  const testStems = new Set(["test", "spec", "тест", "протест"]);

  const words = extractWords(promptLower);
  for (const word of words) { for (const s of bugStems) { if (word.startsWith(s)) return "bugfix"; } }
  for (const word of words) { for (const s of refactorStems) { if (word.startsWith(s)) return "refactor"; } }
  for (const word of words) { for (const s of docStems) { if (word.startsWith(s)) return "docs"; } }
  for (const word of words) { for (const s of testStems) { if (word.startsWith(s)) return "testing"; } }
  return "new_feature";
}

export function extractTaskTitle(prompt: string): string {
  let text = prompt.trim();
  for (const prefix of ["please ", "can you ", "i need to ", "i want to ", "let's ", "пожалуйста ", "нужно "]) {
    if (text.toLowerCase().startsWith(prefix)) text = text.slice(prefix.length);
  }
  for (const sep of [".", "\n", ",", " - ", " — "]) {
    const idx = text.indexOf(sep);
    if (idx > 10 && idx < 80) { text = text.slice(0, idx); break; }
  }
  text = text.trim();
  if (text.length > 60) text = text.slice(0, 60).replace(/\s+\S*$/, "") + "...";
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Untitled task";
}

export function detectPriority(promptLower: string): string {
  const p1Stems = new Set(["bug", "broken", "urgent", "critical", "crash", "hotfix", "asap",
    "баг", "срочн", "критичн", "термінов", "сломал", "поломал", "упал"]);
  const p3Stems = new Set(["minor", "cleanup", "chore", "мелоч", "незначн", "дрібниц"]);
  const p3Phrases = ["nice to have", "low priority", "не срочно", "не терміново"];
  const negationPhrases = ["не срочн", "не критичн", "не термінов", "not urgent", "not critical"];

  for (const phrase of negationPhrases) { if (promptLower.includes(phrase)) return "P3"; }
  const words = extractWords(promptLower);
  for (const word of words) { for (const s of p1Stems) { if (word.startsWith(s)) return "P1"; } }
  for (const phrase of p3Phrases) { if (promptLower.includes(phrase)) return "P3"; }
  for (const word of words) { for (const s of p3Stems) { if (word.startsWith(s)) return "P3"; } }
  return "P2";
}

export interface IntentResult {
  action: "suppress" | "question" | "reuse" | "continue" | "create" | "none";
  task_id?: string;
  title?: string;
  priority?: string;
  intent?: string;
  match_layer?: string;
}

export interface TaskInfo {
  id: string;
  task: string;
  status?: string;
  [key: string]: unknown;
}

export function classifyIntent(
  prompt: string,
  existingTasks: TaskInfo[],
  activeTaskId: string | null = null,
): IntentResult {
  const promptLower = prompt.toLowerCase().trim();
  const promptWords = extractWords(promptLower);

  // Layer 1: Suppression
  for (const phrase of SUPPRESS_PHRASES) {
    if (promptLower.includes(phrase)) return { action: "suppress" };
  }

  // Layer 2: Question detection
  const firstWord = promptLower.split(/\s+/)[0] ?? "";
  const isShort = prompt.length < 120;
  const endsQuestion = prompt.trimEnd().endsWith("?");
  const [hasWork, workMatchLayer] = hasWorkStem(promptWords);

  if (isQuestionWord(firstWord) && isShort && !hasWork) return { action: "question", intent: "question" };
  if (endsQuestion && isShort && !hasWork) return { action: "question", intent: "question" };

  // Layer 2.5: Agent command detection — git ops, test runs, session phrases
  // These pass through silently without creating tasks
  const commandType = isAgentCommand(promptLower, promptWords);
  if (commandType) return { action: "none", intent: "command", match_layer: commandType };

  // Layer 3: Explicit EXE-### reference
  const exeMatch = EXE_PATTERN.exec(prompt);
  if (exeMatch) {
    const foundId = exeMatch[0].toUpperCase();
    for (const t of existingTasks) {
      if (t.id.toUpperCase() === foundId) {
        return { action: "reuse", task_id: t.id, intent: classifyWorkType(promptLower) };
      }
    }
    return { action: "reuse", task_id: foundId, intent: classifyWorkType(promptLower) };
  }

  // Layer 4: Continuation
  if (activeTaskId && hasContinuation(promptWords)) {
    return { action: "continue", task_id: activeTaskId, intent: classifyWorkType(promptLower) };
  }

  // Layer 5: Token overlap with IN_PROGRESS tasks
  const inProgress = existingTasks.filter(t => t.status === "IN_PROGRESS");
  for (const t of inProgress) {
    const titleWords = extractWords(t.task.toLowerCase());
    if (titleWords.size > 0) {
      let overlap = 0;
      for (const w of promptWords) { if (titleWords.has(w)) overlap++; }
      if (overlap / Math.max(titleWords.size, 1) > 0.5) {
        return { action: "reuse", task_id: t.id, intent: classifyWorkType(promptLower) };
      }
    }
  }

  // Layer 6: Work intent
  if (hasWork) {
    // Short-prompt guard: very short prompts with no domain nouns are agent commands
    if (prompt.length < 30 && extractDomainNouns(promptWords).size === 0) {
      return { action: "none", intent: "command", match_layer: "generic" };
    }
    return {
      action: "create",
      title: extractTaskTitle(prompt),
      priority: detectPriority(promptLower),
      intent: classifyWorkType(promptLower),
      match_layer: workMatchLayer ?? undefined,
    };
  }

  // Layer 6.5: Implicit intent
  const implicit = hasImplicitIntent(promptLower);
  if (implicit) {
    return {
      action: "create",
      title: extractTaskTitle(prompt),
      priority: detectPriority(promptLower),
      intent: implicit,
      match_layer: "implicit",
    };
  }

  return { action: "none", intent: "question" };
}

// ── Architecture file detection ─────────────────────────────────────────

const ARCH_RE = new RegExp(
  ["/routes?/", "/middleware/", "/schema", "/migrations?/", "\\.proto$", "/api/",
   "/docker", "docker-compose", "Dockerfile", "\\.graphql$", "/models?/", "/entities?/",
   "/services?/", "openapi", "swagger", "\\.prisma$", "/config/", "vercel\\.json$",
   "next\\.config", "tsconfig"].join("|"),
  "i"
);

export function isArchitectureFile(filepath: string): boolean {
  return ARCH_RE.test(filepath);
}

// ── Evidence parsers ────────────────────────────────────────────────────

const TEST_COMMANDS_RE = /\b(?:npm\s+test|npx\s+vitest|npx\s+jest|pnpm\s+test|go\s+test|pytest|cargo\s+test|mix\s+test|bundle\s+exec\s+rspec|npm\s+run\s+test|pnpm\s+e2e|npx\s+playwright)\b/i;
const COMMIT_COMMANDS_RE = /\bgit\s+commit\b/i;

export function isTestCommand(command: string): boolean {
  return TEST_COMMANDS_RE.test(command);
}

export function isCommitCommand(command: string): boolean {
  return COMMIT_COMMANDS_RE.test(command);
}

export function extractTestResults(output: string): [boolean, boolean | null, string] {
  const text = output.slice(0, 3000);
  const passPatterns = [/(\d+)\s+pass(?:ed|ing)?/i, /Tests:\s+(\d+)\s+passed/i, /PASS\b/i, /All tests passed/i];
  const failPatterns = [/[1-9]\d*\s+(?:tests?\s+)?fail(?:ed|ing|ure)?/i, /FAIL\s+\S/i, /ERROR\b.*test/i];

  const hasPass = passPatterns.some(p => p.test(text));
  const hasFail = failPatterns.some(p => p.test(text));

  if (hasFail) return [true, false, "Tests FAILED"];
  if (hasPass) {
    const m = text.match(/(\d+)\s+pass/i);
    return [true, true, `Tests passed (${m ? m[1] : "all"})`];
  }
  return [false, null, ""];
}

export function extractCommitSha(output: string): string | null {
  const text = output.slice(0, 2000);
  let m = text.match(/\[[\w/.-]+\s+([0-9a-f]{6,12})\]/);
  if (m) return m[1];
  m = text.match(/commit\s+([0-9a-f]{7,40})/i);
  return m ? m[1].slice(0, 12) : null;
}

export function extractCommitMessage(output: string): string {
  const text = output.slice(0, 2000);
  const m = text.match(/\[[\w/.-]+\s+[0-9a-f]+\]\s+(.+)/);
  return m ? m[1].trim() : "";
}

// ── Self-learning: event logging ────────────────────────────────────────

function resolveLearningsDir(projectPath: string): string | null {
  try {
    const resolveModule = path.resolve(__dirname, "..", "..", "vault", "resolve.js");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execPath: ep } = require(resolveModule);
    const [execDir, err] = ep(projectPath) as [string | null, string | null];
    if (err || !execDir) return null;
    return path.join(execDir, "Learnings");
  } catch {
    return null;
  }
}

export function logLearningEvent(projectPath: string, eventType: string, data: Record<string, unknown>): void {
  try {
    const dir = resolveLearningsDir(projectPath);
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "Learning Log.md");

    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    let entry = `\n## ${now} — ${eventType}\n`;
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined) entry += `- ${k}: ${v}\n`;
    }

    fs.appendFileSync(logPath, entry, "utf-8");
  } catch {
    // Never break user flow
  }
}

// ── Predictive Brain ────────────────────────────────────────────────────

interface LearningEvent {
  timestamp: string;
  event_type: string;
  [key: string]: unknown;
}

/** Maximum learning log size to parse (1 MB). */
const MAX_LEARNING_LOG_SIZE = 1024 * 1024;
/** Maximum number of lines to parse from learning log. */
const MAX_LEARNING_LOG_LINES = 1000;

function parseLearningEvents(projectPath: string): LearningEvent[] {
  const dir = resolveLearningsDir(projectPath);
  if (!dir) return [];
  const logPath = path.join(dir, "Learning Log.md");
  let content: string;
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > MAX_LEARNING_LOG_SIZE) {
      // Read only the last 1MB to get recent events
      const fd = fs.openSync(logPath, "r");
      const buf = Buffer.alloc(MAX_LEARNING_LOG_SIZE);
      fs.readSync(fd, buf, 0, MAX_LEARNING_LOG_SIZE, stat.size - MAX_LEARNING_LOG_SIZE);
      fs.closeSync(fd);
      content = buf.toString("utf-8");
    } else {
      content = fs.readFileSync(logPath, "utf-8");
    }
  } catch { return []; }
  if (!content.trim()) return [];

  const events: LearningEvent[] = [];
  let current: LearningEvent | null = null;
  const lines = content.split("\n");
  const linesToParse = lines.length > MAX_LEARNING_LOG_LINES ? lines.slice(-MAX_LEARNING_LOG_LINES) : lines;
  for (const line of linesToParse) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ") && trimmed.includes(" — ")) {
      if (current) events.push(current);
      const parts = trimmed.slice(3).split(" — ", 2);
      current = { timestamp: parts[0].trim(), event_type: parts[1]?.trim() ?? "unknown" };
    } else if (trimmed.startsWith("- ") && current) {
      const kv = trimmed.slice(2).split(": ", 2);
      if (kv.length === 2) {
        const [key, val] = [kv[0].trim(), kv[1].trim()];
        if (val.toLowerCase() === "true") current[key] = true;
        else if (val.toLowerCase() === "false") current[key] = false;
        else if (val.toLowerCase() === "none") current[key] = null;
        else {
          const num = val.includes(".") ? parseFloat(val) : parseInt(val, 10);
          current[key] = isNaN(num) ? val : num;
        }
      }
    }
  }
  if (current) events.push(current);
  return events;
}

export function predictCycleTime(projectPath: string, workType = "unknown"): Record<string, unknown> {
  const events = parseLearningEvents(projectPath);
  const completed = events.filter(e =>
    ["task_completed", "session_ended"].includes(e.event_type) &&
    typeof e.cycle_time_hours === "number" && (e.cycle_time_hours as number) > 0
  );
  if (!completed.length) return { predicted_hours: null, confidence: "none", sample_size: 0 };

  const sameType = workType !== "unknown" ? completed.filter(e => e.work_type === workType) : [];
  const sample = sameType.length >= 3 ? sameType : completed;
  const times = sample.map(e => e.cycle_time_hours as number).sort((a, b) => a - b);
  const n = times.length;
  const median = n % 2 === 0 ? (times[n / 2 - 1] + times[n / 2]) / 2 : times[Math.floor(n / 2)];
  const q1 = n >= 4 ? times[Math.floor(n / 4)] : times[0];
  const q3 = n >= 4 ? times[Math.floor((3 * n) / 4)] : times[n - 1];
  const confidence = n >= 10 ? "high" : n >= 5 ? "medium" : n >= 3 ? "low" : "very_low";

  return {
    predicted_hours: Math.round(median * 10) / 10,
    range_low: Math.round(q1 * 10) / 10,
    range_high: Math.round(q3 * 10) / 10,
    confidence, sample_size: n, work_type_match: sameType.length >= 3,
  };
}

export function predictRisk(projectPath: string, filesToChange: string[]): Record<string, unknown> {
  const events = parseLearningEvents(projectPath);
  const corrections = events.filter(e => e.event_type === "user_correction");
  const verifyEvents = events.filter(e => e.event_type === "verification_result");
  const reopened = corrections.filter(e => e.type === "task_reopened" || e.signal === "premature_auto_completion");

  const reasons: string[] = [];
  let riskScore = 0;

  if (filesToChange.length > 5) { riskScore += 2; reasons.push(`${filesToChange.length} files to change — high scope`); }
  else if (filesToChange.length > 3) { riskScore += 1; reasons.push(`${filesToChange.length} files — moderate scope`); }

  const archFiles = filesToChange.filter(f => isArchitectureFile(f));
  if (archFiles.length) { riskScore += 2; reasons.push(`Architecture file(s): ${archFiles.map(f => path.basename(f)).slice(0, 3).join(", ")}`); }
  if (reopened.length > 2) { riskScore += 1; reasons.push(`${reopened.length} tasks were reopened — auto-complete may be unreliable`); }
  const failedVer = verifyEvents.filter(e => !e.all_passed);
  if (failedVer.length > 1) { riskScore += 1; reasons.push(`${failedVer.length} verify failures in history — add verify checks`); }

  const riskLevel = riskScore >= 4 ? "high" : riskScore >= 2 ? "medium" : "low";
  return { risk_level: riskLevel, risk_score: riskScore, reasons, recommendation: riskScore >= 2 ? "Add verify: checks to this task" : null };
}

export function predictPriority(projectPath: string, workType: string, fileCount = 0): Record<string, unknown> {
  const events = parseLearningEvents(projectPath);
  const completed = events.filter(e => ["task_completed", "session_ended"].includes(e.event_type) && e.work_type);
  if (!completed.length) {
    if (workType === "bugfix") return { suggested_priority: "P1", confidence: "heuristic", reasoning: "Bugfixes default to P1" };
    return { suggested_priority: "P2", confidence: "heuristic", reasoning: "Default priority" };
  }

  const corrections = events.filter(e => e.event_type === "user_correction" && e.type === "priority_changed");
  const sameType = completed.filter(e => e.work_type === workType);
  const priorityCounts: Record<string, number> = {};
  for (const e of sameType) {
    const p = String(e.original_priority ?? "P2");
    if (p.startsWith("P")) priorityCounts[p] = (priorityCounts[p] ?? 0) + 1;
  }

  let mostCommon: string;
  let reasoning: string;
  if (Object.keys(priorityCounts).length) {
    mostCommon = Object.entries(priorityCounts).sort((a, b) => b[1] - a[1])[0][0];
    const total = Object.values(priorityCounts).reduce((a, b) => a + b, 0);
    reasoning = `${workType} tasks are usually ${mostCommon} (${Math.round(priorityCounts[mostCommon] / total * 100)}% of ${total} tasks)`;
  } else {
    mostCommon = workType === "bugfix" ? "P1" : "P2";
    reasoning = `No history for ${workType} — using default`;
  }

  if (corrections.length) {
    const upCorr = corrections.filter(c => String(c.from ?? "P2") > String(c.to ?? "P2"));
    if (upCorr.length > corrections.length / 2) {
      const order: Record<string, string> = { P3: "P2", P2: "P1", P1: "P1" };
      mostCommon = order[mostCommon] ?? mostCommon;
      reasoning += " (adjusted up — you often increase priority)";
    }
  }

  if (fileCount > 5 && mostCommon === "P3") { mostCommon = "P2"; reasoning += " (bumped: high file count)"; }

  return {
    suggested_priority: mostCommon,
    confidence: sameType.length >= 5 ? "high" : sameType.length >= 2 ? "medium" : "low",
    reasoning,
  };
}

export function getFileHistory(projectPath: string, filePath: string): { count: number; reopened: number; tasks: string[] } {
  try {
    const resolveModule = path.resolve(__dirname, "..", "..", "vault", "resolve.js");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execPath: ep } = require(resolveModule);
    const [execDir, err] = ep(projectPath) as [string | null, string | null];
    if (err || !execDir) return { count: 0, reopened: 0, tasks: [] };

    const tasksDir = path.join(execDir, "Tasks");
    try { if (!fs.statSync(tasksDir).isDirectory()) return { count: 0, reopened: 0, tasks: [] }; } catch { return { count: 0, reopened: 0, tasks: [] }; }

    const basename = path.basename(filePath);
    const matchingTasks: string[] = [];
    for (const fname of fs.readdirSync(tasksDir)) {
      if (!fname.endsWith(".md")) continue;
      const tc = fs.readFileSync(path.join(tasksDir, fname), "utf-8");
      if (tc.includes(basename) || tc.includes(filePath)) {
        matchingTasks.push(fname.replace(".md", ""));
      }
    }

    const events = parseLearningEvents(projectPath);
    const corrections = events.filter(e =>
      e.event_type === "user_correction" && e.type === "task_reopened" && matchingTasks.includes(String(e.task_id ?? ""))
    );

    return { count: matchingTasks.length, reopened: corrections.length, tasks: matchingTasks.slice(0, 5) };
  } catch {
    return { count: 0, reopened: 0, tasks: [] };
  }
}
