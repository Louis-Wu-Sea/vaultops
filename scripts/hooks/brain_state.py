#!/usr/bin/env python3
"""VaultOps Brain — shared state module for autonomous hook coordination.

All 5 hooks (session_init, prompt_analyzer, pre_context, post_log, session_summary)
share session state through a JSON file on disk. This module provides the state
management, intent classification, and evidence parsing logic.

Python stdlib only — no external dependencies.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


# ── Session state path ────────────────────────────────────────────────────

def state_path(project_path: str) -> str:
    """Deterministic temp path for session state keyed by project."""
    h = hashlib.md5(project_path.encode()).hexdigest()[:12]
    return os.path.join(tempfile.gettempdir(), f"vaultops-brain-{h}.json")


_DEFAULT_STATE: Dict[str, Any] = {
    "session_start": "",
    "phase": "idle",
    "active_task_id": None,
    "task_auto_created": False,
    "intent": None,
    "user_prompt_summary": "",
    "files_edited": [],
    "files_created": [],
    "bash_commands_summary": [],
    "tests_run": False,
    "tests_passed": None,
    "commits": [],
    "docs_touched": [],
    "suppressed": False,
    "prompt_count": 0,
    # Self-learning fields
    "intent_match_layer": None,       # which detection layer matched (stem/transliterate/fuzzy/implicit)
    "original_priority": None,        # priority at auto-creation time for correction detection
    # Auto-trigger fields
    "enrichment_count": 0,            # role outputs written this session (triggers DNA rebuild at 5)
    "risk_warned": False,             # prevent duplicate risk warnings per session
    "hotspot_warned": [],             # files already warned about (prevent spam)
}


def load_state(project_path: str) -> Dict[str, Any]:
    """Read session state from disk, return defaults if missing."""
    fp = state_path(project_path)
    try:
        with open(fp, "r", encoding="utf-8") as f:
            data = json.load(f)
        # Merge with defaults for forward-compat
        merged = dict(_DEFAULT_STATE)
        merged.update(data)
        return merged
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return dict(_DEFAULT_STATE)


def save_state(project_path: str, state: Dict[str, Any]) -> None:
    """Atomic write session state to disk."""
    fp = state_path(project_path)
    tmp = fp + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
        os.replace(tmp, fp)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def cleanup_state(project_path: str) -> None:
    """Remove session state file."""
    try:
        os.unlink(state_path(project_path))
    except OSError:
        pass


def is_vaultops_project(project_path: str) -> bool:
    """Check if CWD has VaultOps configured."""
    return os.path.isfile(os.path.join(project_path, ".vaultops", "config.env"))


# ── Intent classification ─────────────────────────────────────────────────

# Stem-based matching: instead of exact words, we use prefix stems
# so "исправь", "исправить", "исправил", "исправления" all match stem "исправ"
# This handles morphology across EN/RU/UK without any NLP library.

# English stems (3-6 chars) — covers all conjugations/forms
_EN_WORK_STEMS = {
    "add", "fix", "impl", "creat", "updat", "refact", "build",
    "remov", "delet", "migrat", "deploy", "config", "optim",
    "test", "writ", "instal", "setup", "chang", "modif",
    "replac", "mov", "renam", "extract", "split", "merg", "upgrad",
    "downgrad", "enabl", "disabl", "connect", "integrat", "debug",
    "rewrit", "redesign", "patch", "resolv", "handl", "convert",
    "scaffold", "bootstrap", "generat", "compil", "bundl",
}

# Russian stems — covers imperative, infinitive, past tense, gerund
_RU_WORK_STEMS = {
    "добав",     # добавь, добавить, добавил, добавляю, добавление
    "исправ",    # исправь, исправить, исправил, исправления
    "созда",     # создай, создать, создал, создание
    "обнов",     # обнови, обновить, обновил, обновление
    "удал",      # удали, удалить, удалил, удаление
    "настро",    # настрой, настроить, настроил
    "сделай", "сделат", "сделал",  # сделай, сделать, сделал (NOT "делает" — question word)
    "поправ",    # поправь, поправить, поправил
    "перепис",   # перепиши, переписать, переписал
    "переделa",  # переделай, переделать
    "поменя",    # поменяй, поменять, поменял
    "убер",      # убери, убрать
    "почин",     # почини, починить, починил
    "разверн",   # разверни, развернуть (deploy)
    "накат",     # накати, накатить (apply migration)
    "раскат",    # раскати, раскатить (rollout)
    "залей",     # залей (upload/deploy slang)
    "запуст",    # запусти, запустить, запустил
    "подключ",   # подключи, подключить
    "отключ",    # отключи, отключить
    "перенес",   # перенеси, перенести
    "вынес",     # вынеси, вынести (extract)
    "разбе",     # разбей, разбить (split)
    "объедин",   # объедини, объединить (merge)
    "реализ",    # реализуй, реализовать (implement)
    "оптимиз",   # оптимизируй, оптимизировать
    "рефактор",  # рефактори, рефакторить
    "отрефакт",  # отрефактори
    "дебаг",     # дебагни
    "протест",   # протестируй, протестировать
    "задеплой",  # задеплой, задеплоить
}

# Ukrainian stems
_UK_WORK_STEMS = {
    "додай",     # додай, додати, додав
    "додат",
    "виправ",    # виправ, виправити, виправив
    "створ",     # створи, створити, створив, створення
    "зроб",      # зроби, зробити, зробив
    "оновл",     # онови, оновити, оновив  (also оновлення)
    "оптиміз",   # оптимізуй, оптимізувати
    "налашт",    # налаштуй, налаштувати
    "видал",     # видали, видалити, видалив
    "перепис",   # перепиши, переписати
    "замін",     # заміни, замінити
    "перенес",   # перенеси, перенести
    "підключ",   # підключи, підключити
    "відключ",   # відключи, відключити
    "розгорн",   # розгорни, розгорнути (deploy)
    "запуст",    # запусти, запустити
    "рефактор",  # рефактори
    "реалізув",  # реалізуй, реалізувати
    "протест",   # протестуй, протестувати
}

# Cyrillic spellings of English tech verbs (loan-word stems)
_HYBRID_STEMS = {
    "фикс",     # fix (пофиксить, фиксить)
    "деплой",   # deploy (задеплоить, деплоить)
    "пуш",      # push (пушить, пропушить, запушить)
    "пул",      # pull (пульнуть, запулить)
    "мёрж", "мерж",  # merge (замёржить, мержить)
    "коммит",   # commit (закоммитить, коммитить)
    "ревью",    # review (заревьюить)
    "билд",     # build (забилдить, билдить)
    "хендл",    # handle (захендлить)
    "чекаут",   # checkout (зачекаутить)
    "ребейз",   # rebase (заребейзить)
    "хотфикс",  # hotfix
    "роллбек", "роллбэк",  # rollback
    "рестарт",  # restart
    "апдейт",   # update
    "апгрейд",  # upgrade
}

_ALL_WORK_STEMS = _EN_WORK_STEMS | _RU_WORK_STEMS | _UK_WORK_STEMS | _HYBRID_STEMS


# ── Transliteration & mixed-script decomposition ─────────────────────────

_TRANSLIT = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
    'і': 'i', 'ї': 'yi', 'є': 'ye', 'ґ': 'g',
}

# Slavic prefixes/suffixes that wrap English tech roots
_SLAVIC_PREFIXES = ("пере", "за", "по", "на", "от", "об", "про", "вы", "при", "раз",
                    "під", "від", "роз", "пре")
_SLAVIC_SUFFIXES = ("ить", "ать", "ять", "уть", "нуть", "ти", "ся", "сь",
                    "ни", "ну", "ай", "уй", "и")


def _transliterate(word: str) -> str:
    """Convert Cyrillic word to Latin approximation."""
    return "".join(_TRANSLIT.get(c, c) for c in word)


def _decompose_mixed(word: str) -> Optional[str]:
    """Try to extract a tech root from a slavic-wrapped word.

    'пофикси' → strip 'по' + 'и' → 'фикс' → transliterate → 'fiks'
    'задеплоить' → strip 'за' + 'ить' → 'деплой' → transliterate → 'deploy'
    'замёржить' → strip 'за' + 'ить' → 'мёрж' → transliterate → 'myorzh'
    """
    if len(word) < 4:
        return None

    # Strip prefix
    core = word
    for pfx in _SLAVIC_PREFIXES:
        if word.startswith(pfx) and len(word) > len(pfx) + 2:
            core = word[len(pfx):]
            break

    # Strip suffix
    for sfx in _SLAVIC_SUFFIXES:
        if core.endswith(sfx) and len(core) > len(sfx) + 2:
            core = core[:-len(sfx)]
            break

    # Only return if we actually stripped something
    if core != word and len(core) >= 3:
        return core
    return None


# ── Fuzzy matching via difflib ────────────────────────────────────────────

from difflib import SequenceMatcher  # noqa: E402 (stdlib)


def _fuzzy_stem_match(word: str, stems: set, threshold: float = 0.7) -> bool:
    """Approximate match for typos using SequenceMatcher.

    Compares only the first len(stem)+2 chars of the word to avoid
    penalizing long words against short stems.
    """
    for stem in stems:
        # Compare prefix of word (stem-length + 2 tolerance)
        prefix = word[:len(stem) + 2]
        if SequenceMatcher(None, prefix, stem).ratio() >= threshold:
            return True
    return False


# ── Implicit intent patterns (no verb, but clear intent) ──────────────────

_IMPLICIT_WORK_PATTERNS = [
    # Broken / not working → bugfix
    (re.compile(r"(сломал|поломал|\bупал\b|не работает|не запускается|broken|doesn't work|не робить|не працює|падает|крашит)", re.I), "bugfix"),
    # Bad code quality → refactor
    (re.compile(r"(ужас\w*|кошмар|говнокод|terrible|awful|messy|грязн|бардак|хаос|legacy)", re.I), "refactor"),
    # Slow → refactor/optimize
    (re.compile(r"(медленн|тормоз|slow|laggy|повільн|\bдолго\b|долго грузит|висит)", re.I), "refactor"),
    # Need to do something → new_feature (RU)
    (re.compile(r"нужн[оа]?\s+(бы\s+)?(сделать|добавить|написать|реализовать)", re.I), "new_feature"),
    # Need to do something → new_feature (UK)
    (re.compile(r"треба\s+(зробити|додати|написати|реалізувати)", re.I), "new_feature"),
    # Would be good to... → new_feature
    (re.compile(r"(хорошо бы|было бы неплохо|стоит|надо бы|варто було б)", re.I), "new_feature"),
]


# ── Main work-stem detection pipeline ─────────────────────────────────────

def _has_work_stem(words: set) -> Tuple[bool, Optional[str]]:
    """3-layer detection: exact stem → decompose+transliterate → fuzzy fallback.

    Returns (matched: bool, layer: str|None) where layer is "stem", "transliterate", or "fuzzy".
    """

    # Layer 1: exact prefix match (fast path, covers 90%+ cases)
    for word in words:
        for stem in _ALL_WORK_STEMS:
            if word.startswith(stem):
                return True, "stem"

    # Layer 2: decompose mixed-script words and transliterate
    # Handles: "пофикси"→"фикс"→"fiks"≈"fix", "задеплоить"→"деплой"→"deploy"
    for word in words:
        root = _decompose_mixed(word)
        if root:
            # Check Cyrillic root against hybrid stems first
            for stem in _HYBRID_STEMS:
                if root.startswith(stem):
                    return True, "transliterate"
            # Then transliterate and check against English stems
            transliterated = _transliterate(root)
            for stem in _EN_WORK_STEMS:
                if transliterated.startswith(stem) or stem.startswith(transliterated):
                    return True, "transliterate"

    # Layer 3: fuzzy fallback for typos (only on short words)
    # Handles: "ісправь"≈"исправ", "додвй"≈"додай"
    # Skip words that look like question/common words to avoid false positives
    _FUZZY_SKIP = {"делает", "делать", "делал", "делаю", "робить", "робит",
                   "модуль", "работа", "работает", "файл", "файлы", "проект"}
    for word in words:
        if 3 <= len(word) <= 14 and word not in _FUZZY_SKIP:
            if _fuzzy_stem_match(word, _ALL_WORK_STEMS, 0.75):
                return True, "fuzzy"

    return False, None


def _has_implicit_intent(prompt_lower: str) -> Optional[str]:
    """Check for implicit work intent without explicit verbs."""
    for pattern, intent_type in _IMPLICIT_WORK_PATTERNS:
        if pattern.search(prompt_lower):
            return intent_type
    return None


# Question detection — prefix-based too for RU/UK morphology
_EN_QUESTION_STARTS = {
    "what", "how", "why", "where", "when", "which", "who",
    "is", "are", "can", "could", "would", "should", "does", "do",
    "explain", "tell", "describe", "show", "list",
}
_RU_QUESTION_STEMS = {
    "что", "как", "почему", "зачем", "где", "когда", "кто", "какой", "какая", "какие",
    "объясн", "расскаж", "покаж", "опиши", "перечисл",
}
_UK_QUESTION_STEMS = {
    "що", "як", "чому", "навіщо", "де", "коли", "хто", "який", "яка", "які",
    "поясн", "розкаж", "покаж", "опиш",
}

QUESTION_STARTS = _EN_QUESTION_STARTS  # exact match for EN first word


def _is_question_word(word: str) -> bool:
    """Check if word is a question word (exact for EN, stem for RU/UK)."""
    if word in _EN_QUESTION_STARTS:
        return True
    for stem in _RU_QUESTION_STEMS | _UK_QUESTION_STEMS:
        if word.startswith(stem):
            return True
    return False


SUPPRESS_PHRASES = [
    "don't track", "dont track", "no task", "skip tracking", "skip vaultops",
    "just a question",
    # Russian (also matches typos like "не трэкай")
    "не трекай", "не трэкай", "без задачи", "без таски", "не логируй",
    # Ukrainian
    "не відслідковуй", "без задачі", "не трекай", "без таски",
]

# Continuation — stem-based
_CONTINUATION_STEMS = {
    # EN
    "now", "also", "next", "then", "continu", "and",
    # RU
    "теперь", "тепер", "ещ", "еще", "дале", "потом", "продолж",
    # UK
    "також", "далі", "тепер", "продовж",
}


def _has_continuation(words: set) -> bool:
    """Check if any word starts with a continuation stem."""
    for word in words:
        for stem in _CONTINUATION_STEMS:
            if word.startswith(stem):
                return True
    return False

_EXE_PATTERN = re.compile(r"EXE-\d+(?:\.\d+)?", re.IGNORECASE)


def classify_intent(
    prompt: str,
    existing_tasks: List[Dict[str, str]],
    active_task_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Classify user prompt into an action.

    Returns dict with keys:
        action: "suppress" | "question" | "reuse" | "continue" | "create" | "none"
        task_id: str or None (for reuse/continue)
        title: str (for create)
        priority: str (for create)
        intent: str (question/bugfix/new_feature/refactor/docs/chore)
    """
    prompt_lower = prompt.lower().strip()
    prompt_words = set(re.findall(r"[a-zA-Zа-яА-ЯіІїЇєЄґҐёЁ]+", prompt_lower))

    # Layer 1: Suppression
    for phrase in SUPPRESS_PHRASES:
        if phrase in prompt_lower:
            return {"action": "suppress"}

    # Layer 2: Question detection (stem-based for RU/UK morphology)
    first_word = prompt_lower.split()[0] if prompt_lower else ""
    is_short = len(prompt) < 120
    ends_question = prompt.rstrip().endswith("?")
    has_work_verb, work_match_layer = _has_work_stem(prompt_words)

    if _is_question_word(first_word) and is_short and not has_work_verb:
        return {"action": "question", "intent": "question"}
    if ends_question and is_short and not has_work_verb:
        return {"action": "question", "intent": "question"}

    # Layer 3: Explicit EXE-### reference
    exe_match = _EXE_PATTERN.search(prompt)
    if exe_match:
        found_id = exe_match.group(0).upper()
        for t in existing_tasks:
            if t["id"].upper() == found_id:
                return {"action": "reuse", "task_id": t["id"], "intent": _classify_work_type(prompt_lower)}
        # Referenced but doesn't exist — continue anyway
        return {"action": "reuse", "task_id": found_id, "intent": _classify_work_type(prompt_lower)}

    # Layer 4: Continuation of active task (stem-based)
    if active_task_id and _has_continuation(prompt_words):
        return {"action": "continue", "task_id": active_task_id, "intent": _classify_work_type(prompt_lower)}

    # Layer 5: Token overlap with existing IN_PROGRESS tasks
    in_progress = [t for t in existing_tasks if t.get("status") == "IN_PROGRESS"]
    if in_progress:
        for t in in_progress:
            title_words = set(re.findall(r"[a-zA-Zа-яА-ЯіІїЇєЄґҐёЁ]+", t["task"].lower()))
            if title_words and len(prompt_words & title_words) / max(len(title_words), 1) > 0.5:
                return {"action": "reuse", "task_id": t["id"], "intent": _classify_work_type(prompt_lower)}

    # Layer 6: Work intent — verb detected (exact stem, decompose, or fuzzy)
    if has_work_verb:
        title = extract_task_title(prompt)
        priority = detect_priority(prompt_lower)
        return {
            "action": "create",
            "title": title,
            "priority": priority,
            "intent": _classify_work_type(prompt_lower),
            "match_layer": work_match_layer,
        }

    # Layer 6.5: Implicit intent — no verb, but clear work signal
    # "этот код ужасен" → refactor, "логин не работает" → bugfix
    implicit = _has_implicit_intent(prompt_lower)
    if implicit:
        title = extract_task_title(prompt)
        priority = detect_priority(prompt_lower)
        return {
            "action": "create",
            "title": title,
            "priority": priority,
            "intent": implicit,
            "match_layer": "implicit",
        }

    # Layer 7: Fallback — no task
    return {"action": "none", "intent": "question"}


def _classify_work_type(prompt_lower: str) -> str:
    """Classify work type from prompt text using stem matching."""
    _bug_stems = {"fix", "bug", "broken", "error", "crash", "исправ", "баг", "ошибк", "помилк",
                  "виправ", "почин", "поправ", "фикс", "хотфикс", "сломал", "поломал",
                  "упал", "падает", "крашит", "не работает", "не запускается"}
    _refactor_stems = {"refact", "optim", "cleanup", "simplif", "рефактор", "оптиміз", "оптимиз",
                       "ужасн", "говнокод", "грязн", "тормоз", "медленн"}
    _doc_stems = {"document", "docs", "readme", "документ", "документац"}
    _test_stems = {"test", "spec", "тест", "протест"}

    words = set(re.findall(r"[a-zA-Zа-яА-ЯіІїЇєЄґҐёЁ]+", prompt_lower))
    for word in words:
        for stem in _bug_stems:
            if word.startswith(stem):
                return "bugfix"
    for word in words:
        for stem in _refactor_stems:
            if word.startswith(stem):
                return "refactor"
    for word in words:
        for stem in _doc_stems:
            if word.startswith(stem):
                return "docs"
    for word in words:
        for stem in _test_stems:
            if word.startswith(stem):
                return "testing"
    return "new_feature"


# ── Task extraction helpers ───────────────────────────────────────────────

def extract_task_title(prompt: str) -> str:
    """Extract a concise title from user prompt. Max 60 chars."""
    # Remove common prefixes
    text = prompt.strip()
    for prefix in ("please ", "can you ", "i need to ", "i want to ", "let's ", "пожалуйста ", "нужно "):
        if text.lower().startswith(prefix):
            text = text[len(prefix):]

    # Take first sentence or up to 60 chars
    for sep in (".", "\n", ",", " - ", " — "):
        idx = text.find(sep)
        if 10 < idx < 80:
            text = text[:idx]
            break

    text = text.strip()
    if len(text) > 60:
        # Cut at last word boundary
        text = text[:60].rsplit(" ", 1)[0] + "..."
    return text.capitalize() if text else "Untitled task"


def detect_priority(prompt_lower: str) -> str:
    """Detect priority from prompt text using stem matching."""
    _p1_stems = {"bug", "broken", "urgent", "critical", "crash", "hotfix", "asap",
                 "баг", "срочн", "критичн", "термінов", "сломал", "поломал", "упал"}
    _p3_stems = {"minor", "cleanup", "chore", "мелоч", "незначн", "дрібниц"}
    _p3_phrases = {"nice to have", "low priority", "не срочно", "не терміново"}
    _negation_phrases = {"не срочн", "не критичн", "не термінов", "not urgent", "not critical"}

    # Check negation first — "не срочно" overrides P1 "срочн" stem
    for phrase in _negation_phrases:
        if phrase in prompt_lower:
            return "P3"

    words = set(re.findall(r"[a-zA-Zа-яА-ЯіІїЇєЄґҐёЁ]+", prompt_lower))
    for word in words:
        for stem in _p1_stems:
            if word.startswith(stem):
                return "P1"
    for phrase in _p3_phrases:
        if phrase in prompt_lower:
            return "P3"
    for word in words:
        for stem in _p3_stems:
            if word.startswith(stem):
                return "P3"
    return "P2"


# ── Architecture file detection ───────────────────────────────────────────

_ARCH_PATTERNS = [
    r"/routes?/",
    r"/middleware/",
    r"/schema",
    r"/migrations?/",
    r"\.proto$",
    r"/api/",
    r"/docker",
    r"docker-compose",
    r"Dockerfile",
    r"\.graphql$",
    r"/models?/",
    r"/entities?/",
    r"/services?/",
    r"openapi",
    r"swagger",
    r"\.prisma$",
    r"/config/",
    r"vercel\.json$",
    r"next\.config",
    r"tsconfig",
]
_ARCH_RE = re.compile("|".join(_ARCH_PATTERNS), re.IGNORECASE)


def is_architecture_file(filepath: str) -> bool:
    """Check if a file is architecture-significant."""
    return bool(_ARCH_RE.search(filepath))


# ── Evidence parsers ──────────────────────────────────────────────────────

_TEST_COMMANDS = re.compile(
    r"\b(npm\s+test|npx\s+vitest|npx\s+jest|pnpm\s+test|go\s+test|pytest|"
    r"cargo\s+test|mix\s+test|bundle\s+exec\s+rspec|npm\s+run\s+test|"
    r"pnpm\s+e2e|npx\s+playwright)\b",
    re.IGNORECASE,
)

_COMMIT_COMMANDS = re.compile(r"\bgit\s+commit\b", re.IGNORECASE)


def is_test_command(command: str) -> bool:
    """Check if a bash command runs tests."""
    return bool(_TEST_COMMANDS.search(command))


def is_commit_command(command: str) -> bool:
    """Check if a bash command is a git commit."""
    return bool(_COMMIT_COMMANDS.search(command))


def extract_test_results(output: str) -> Tuple[bool, Optional[bool], str]:
    """Parse test output. Returns (is_test, passed, summary).

    Truncates output to first 3000 chars for speed.
    """
    text = output[:3000]

    # Common pass patterns
    pass_patterns = [
        r"(\d+)\s+pass(?:ed|ing)?",
        r"Tests:\s+(\d+)\s+passed",
        r"(\d+)\s+tests?\s+passed",
        r"PASS\b",
        r"ok\s+\d+\s+tests?",
        r"All tests passed",
    ]
    fail_patterns = [
        r"[1-9]\d*\s+(?:tests?\s+)?fail(?:ed|ing|ure)?",  # "3 failed" or "3 tests failed"
        r"FAIL\s+\S",  # FAIL followed by a path/test name
        r"ERROR\b.*test",
        r"AssertionError",
    ]

    has_pass = any(re.search(p, text, re.IGNORECASE) for p in pass_patterns)
    has_fail = any(re.search(p, text, re.IGNORECASE) for p in fail_patterns)

    if has_fail:
        return True, False, "Tests FAILED"
    if has_pass:
        # Try to extract counts
        m = re.search(r"(\d+)\s+pass", text, re.IGNORECASE)
        count = m.group(1) if m else "all"
        return True, True, f"Tests passed ({count})"
    return False, None, ""


def extract_commit_sha(output: str) -> Optional[str]:
    """Extract commit SHA from git commit output."""
    text = output[:2000]
    # Pattern: [branch abc1234] message (git uses 6-12 char short hashes)
    m = re.search(r"\[[\w/.-]+\s+([0-9a-f]{6,12})\]", text)
    if m:
        return m.group(1)
    # Fallback: just a hex string after "commit"
    m = re.search(r"commit\s+([0-9a-f]{7,40})", text, re.IGNORECASE)
    if m:
        return m.group(1)[:12]
    return None


def extract_commit_message(output: str) -> str:
    """Extract commit message from git commit output."""
    text = output[:2000]
    m = re.search(r"\[[\w/.-]+\s+[0-9a-f]+\]\s+(.+)", text)
    return m.group(1).strip() if m else ""


# ── Self-learning: event logging ─────────────────────────────────────────


def _resolve_learnings_dir(project_path: str) -> Optional[str]:
    """Resolve the Learnings directory path for a project. Returns None if vault not found."""
    # Import lazily to avoid circular imports at module level
    try:
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from vaultops_mcp_server import _resolve_vault_project
        vault_project = _resolve_vault_project(project_path)
        if not vault_project:
            return None
        return os.path.join(vault_project, "08-Execution", "Learnings")
    except Exception:
        return None


def log_learning_event(project_path: str, event_type: str, data: Dict[str, Any]) -> None:
    """Append a structured learning event to the Learning Log.

    Best-effort — never raises, never breaks user flow.
    Event types: intent_classified, task_completed, session_ended, user_correction
    """
    try:
        learnings_dir = _resolve_learnings_dir(project_path)
        if not learnings_dir:
            return
        os.makedirs(learnings_dir, exist_ok=True)
        log_path = os.path.join(learnings_dir, "Learning Log.md")

        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        entry = f"\n## {now} — {event_type}\n"
        for k, v in data.items():
            if v is not None:
                entry += f"- {k}: {v}\n"

        with open(log_path, "a", encoding="utf-8") as f:
            f.write(entry)
    except Exception:
        pass  # Never break user flow for learning


# ── Predictive Brain ──────────────────────────────────────────────────────


def _parse_learning_events(project_path: str) -> List[Dict[str, Any]]:
    """Parse all learning events from the Learning Log. Returns empty list on failure."""
    try:
        learnings_dir = _resolve_learnings_dir(project_path)
        if not learnings_dir:
            return []
        log_path = os.path.join(learnings_dir, "Learning Log.md")
        if not os.path.isfile(log_path):
            return []
        content = ""
        with open(log_path, "r", encoding="utf-8") as f:
            content = f.read()
        if not content.strip():
            return []

        events: List[Dict[str, Any]] = []
        current: Optional[Dict[str, Any]] = None
        for line in content.split("\n"):
            line = line.strip()
            if line.startswith("## ") and " — " in line:
                if current:
                    events.append(current)
                parts = line[3:].split(" — ", 1)
                current = {"timestamp": parts[0].strip(), "event_type": parts[1].strip() if len(parts) > 1 else "unknown"}
            elif line.startswith("- ") and current is not None:
                kv = line[2:].split(": ", 1)
                if len(kv) == 2:
                    key, val = kv[0].strip(), kv[1].strip()
                    if val.lower() == "true":
                        current[key] = True
                    elif val.lower() == "false":
                        current[key] = False
                    elif val.lower() == "none":
                        current[key] = None
                    else:
                        try:
                            current[key] = float(val) if "." in val else int(val)
                        except (ValueError, TypeError):
                            current[key] = val
        if current:
            events.append(current)
        return events
    except Exception:
        return []


def predict_cycle_time(project_path: str, work_type: str = "unknown") -> Dict[str, Any]:
    """Predict cycle time based on historical task completions.

    Returns {predicted_hours, confidence, sample_size, similar_tasks}.
    """
    events = _parse_learning_events(project_path)
    completed = [
        e for e in events
        if e.get("event_type") in ("task_completed", "session_ended")
        and e.get("cycle_time_hours") is not None
        and isinstance(e.get("cycle_time_hours"), (int, float))
        and e["cycle_time_hours"] > 0
    ]

    if not completed:
        return {"predicted_hours": None, "confidence": "none", "sample_size": 0}

    # Filter by work_type if known
    same_type = [e for e in completed if e.get("work_type") == work_type] if work_type != "unknown" else []
    sample = same_type if len(same_type) >= 3 else completed

    times = sorted(e["cycle_time_hours"] for e in sample)
    n = len(times)

    # Median is more robust than mean for skewed data
    if n % 2 == 0:
        median = (times[n // 2 - 1] + times[n // 2]) / 2
    else:
        median = times[n // 2]

    # Confidence based on sample size
    if n >= 10:
        confidence = "high"
    elif n >= 5:
        confidence = "medium"
    elif n >= 3:
        confidence = "low"
    else:
        confidence = "very_low"

    # Range (IQR-based)
    q1 = times[n // 4] if n >= 4 else times[0]
    q3 = times[(3 * n) // 4] if n >= 4 else times[-1]

    return {
        "predicted_hours": round(median, 1),
        "range_low": round(q1, 1),
        "range_high": round(q3, 1),
        "confidence": confidence,
        "sample_size": n,
        "work_type_match": len(same_type) >= 3,
    }


def predict_risk(project_path: str, files_to_change: List[str]) -> Dict[str, Any]:
    """Predict risk based on historical file change patterns.

    Returns {risk_level, risky_files, reasons}.
    """
    events = _parse_learning_events(project_path)

    # Build file history: which files were involved in which outcomes
    file_tasks: Dict[str, List[Dict[str, Any]]] = {}  # file -> list of task outcomes
    for e in events:
        if e.get("event_type") in ("task_completed", "session_ended"):
            # We don't have per-file data in learning events,
            # but we can check task files for verify failures
            pass

    # Check verification failures
    verify_events = [e for e in events if e.get("event_type") == "verification_result"]
    corrections = [e for e in events if e.get("event_type") == "user_correction"]

    # Check reopened tasks (signal of problematic areas)
    reopened_tasks = [
        e for e in corrections
        if e.get("type") == "task_reopened" or e.get("signal") == "premature_auto_completion"
    ]

    # Build risk assessment
    reasons: List[str] = []
    risk_score = 0

    # High file count = higher risk
    if len(files_to_change) > 5:
        risk_score += 2
        reasons.append(f"{len(files_to_change)} files to change — high scope")
    elif len(files_to_change) > 3:
        risk_score += 1
        reasons.append(f"{len(files_to_change)} files — moderate scope")

    # Architecture files = higher risk
    arch_files = [f for f in files_to_change if is_architecture_file(f)]
    if arch_files:
        risk_score += 2
        reasons.append(f"Architecture file(s): {', '.join(os.path.basename(f) for f in arch_files[:3])}")

    # High reopened rate = systemic risk
    if len(reopened_tasks) > 2:
        risk_score += 1
        reasons.append(f"{len(reopened_tasks)} tasks were reopened — auto-complete may be unreliable")

    # Verify failures indicate brittle areas
    failed_verifications = [e for e in verify_events if not e.get("all_passed")]
    if len(failed_verifications) > 1:
        risk_score += 1
        reasons.append(f"{len(failed_verifications)} verify failures in history — add verify checks")

    if risk_score >= 4:
        risk_level = "high"
    elif risk_score >= 2:
        risk_level = "medium"
    else:
        risk_level = "low"

    return {
        "risk_level": risk_level,
        "risk_score": risk_score,
        "reasons": reasons,
        "recommendation": "Add verify: checks to this task" if risk_score >= 2 else None,
    }


def predict_priority(project_path: str, work_type: str, file_count: int = 0) -> Dict[str, Any]:
    """Predict priority based on historical priority patterns.

    Returns {suggested_priority, confidence, reasoning}.
    """
    events = _parse_learning_events(project_path)

    completed = [
        e for e in events
        if e.get("event_type") in ("task_completed", "session_ended")
        and e.get("work_type")
    ]

    if not completed:
        # Default heuristics without history
        if work_type == "bugfix":
            return {"suggested_priority": "P1", "confidence": "heuristic", "reasoning": "Bugfixes default to P1"}
        return {"suggested_priority": "P2", "confidence": "heuristic", "reasoning": "Default priority"}

    # Check corrections — what priorities were changed?
    corrections = [
        e for e in events
        if e.get("event_type") == "user_correction" and e.get("type") == "priority_changed"
    ]

    # Analyze priority distribution for this work type
    same_type = [e for e in completed if e.get("work_type") == work_type]
    priority_counts: Dict[str, int] = {}
    for e in same_type:
        p = e.get("original_priority", "P2")
        if isinstance(p, str) and p.startswith("P"):
            priority_counts[p] = priority_counts.get(p, 0) + 1

    if priority_counts:
        # Most common priority for this work type
        most_common = max(priority_counts, key=lambda k: priority_counts[k])
        total = sum(priority_counts.values())
        pct = round(priority_counts[most_common] / total * 100)
        reasoning = f"{work_type} tasks are usually {most_common} ({pct}% of {total} tasks)"
    else:
        most_common = "P1" if work_type == "bugfix" else "P2"
        reasoning = f"No history for {work_type} — using default"

    # Adjust based on correction patterns
    if corrections:
        # If user frequently bumps priority up, suggest higher
        up_corrections = [c for c in corrections if c.get("from", "P2") > c.get("to", "P2")]
        if len(up_corrections) > len(corrections) / 2:
            # User tends to increase priority — suggest one higher
            priority_order = {"P3": "P2", "P2": "P1", "P1": "P1"}
            most_common = priority_order.get(most_common, most_common)
            reasoning += " (adjusted up — you often increase priority)"

    # File count adjustment
    if file_count > 5 and most_common == "P3":
        most_common = "P2"
        reasoning += " (bumped: high file count)"

    return {
        "suggested_priority": most_common,
        "confidence": "high" if len(same_type) >= 5 else "medium" if len(same_type) >= 2 else "low",
        "reasoning": reasoning,
    }


def get_file_history(project_path: str, file_path: str) -> Dict[str, Any]:
    """Check how many tasks touched this file. Returns {count, reopened, tasks}."""
    events = _parse_learning_events(project_path)
    # We can't directly map files to tasks from learning log alone,
    # but we can check task files for evidence referencing this file
    try:
        sys_path_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if sys_path_parent not in sys.path:
            sys.path.insert(0, sys_path_parent)
        from vaultops_mcp_server import _exec_path, _read_file, TASKS_DIR

        exec_dir, err = _exec_path(project_path)
        if err:
            return {"count": 0, "reopened": 0, "tasks": []}

        tasks_dir = os.path.join(exec_dir, TASKS_DIR)
        if not os.path.isdir(tasks_dir):
            return {"count": 0, "reopened": 0, "tasks": []}

        basename = os.path.basename(file_path)
        matching_tasks: List[str] = []
        for fname in os.listdir(tasks_dir):
            if not fname.endswith(".md"):
                continue
            tc = _read_file(os.path.join(tasks_dir, fname))
            if basename in tc or file_path in tc:
                matching_tasks.append(fname.replace(".md", ""))

        # Count reopened from corrections
        corrections = [
            e for e in events
            if e.get("event_type") == "user_correction"
            and e.get("type") == "task_reopened"
            and e.get("task_id") in matching_tasks
        ]

        return {
            "count": len(matching_tasks),
            "reopened": len(corrections),
            "tasks": matching_tasks[:5],
        }
    except Exception:
        return {"count": 0, "reopened": 0, "tasks": []}


def get_predictions(project_path: str, work_type: str = "unknown", files: Optional[List[str]] = None) -> Dict[str, Any]:
    """Get all predictions for a task. Combines cycle time, risk, and priority."""
    cycle = predict_cycle_time(project_path, work_type)
    risk = predict_risk(project_path, files or [])
    priority = predict_priority(project_path, work_type, len(files or []))

    return {
        "cycle_time": cycle,
        "risk": risk,
        "priority": priority,
        "has_enough_data": cycle.get("sample_size", 0) >= 3,
    }
