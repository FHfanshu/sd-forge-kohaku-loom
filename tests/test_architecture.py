from __future__ import annotations

import ast
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "prompt_agent"
TEXT_SUFFIXES = {".css", ".html", ".js", ".json", ".md", ".py", ".svelte", ".ts", ".txt", ".yaml", ".yml"}
SKIP_PARTS = {
    ".git",
    ".loom",
    ".pytest_cache",
    "__pycache__",
    "bin",
    "coverage",
    "node_modules",
    "test-results",
}
GENERATED_OR_LOCKED = {
    pathlib.Path("frontend/pnpm-lock.yaml"),
    pathlib.Path("javascript/prompt_agent_90_ui.js"),
}
HISTORICAL_FILES = {
    pathlib.Path("AUDIT.md"),
    pathlib.Path("ROADMAP.md"),
    pathlib.Path("docs/KOHAKU_LOOM_MIGRATION.md"),
    pathlib.Path("docs/audit-archive-2026-07-19-full.md"),
    pathlib.Path("docs/audit-archive-2026-07-19.md"),
    pathlib.Path("docs/current-architecture-audit.md"),
    pathlib.Path("docs/kt-runtime-migration.md"),
}
NAMING_COMPATIBILITY_FILES = {
    pathlib.Path("frontend/src/storage-migrations.ts"),
    pathlib.Path("frontend/tests/storage-migrations.test.ts"),
    pathlib.Path("javascript/prompt_agent_01_i18n.js"),
    pathlib.Path("tests/test_frontend_svelte_boot.js"),
    pathlib.Path("tests/test_host_bridge.py"),
    pathlib.Path("tests/test_kohaku_attribution.py"),
}
ARCHIVED_RUNTIME_MARKERS = {
    "/kohaku-loom/kt",
    "KT_CONFIG_DIR",
    "Last-Event-ID",
    "assistant_sessions.sqlite3",
    "claimAssistantToolBridge",
    "releaseAssistantToolBridge",
    "kohaku_loom.sidecar",
    "runtime-lock.json",
    "sidecar_manager",
}
ARCHIVED_TECHNICAL_NAME_MARKERS = {
    "Kohaku Loom",
    "KohakuLoom",
    "ForgeNeoQwen3VLPromptTools",
    "javascript/kohaku_loom",
    "scripts/kohaku_loom.py",
    "window.kohakuLoom",
    "/kohaku-loom",
    "kohaku-loom-host",
    "kohaku-loom-svelte-ui",
    "loom_assistant",
}


def source_files() -> list[pathlib.Path]:
    result: list[pathlib.Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        if any(part in SKIP_PARTS for part in path.relative_to(ROOT).parts):
            continue
        if path.relative_to(ROOT) in GENERATED_OR_LOCKED:
            continue
        result.append(path)
    return result


def module_name(path: pathlib.Path) -> str:
    relative = path.relative_to(PACKAGE).with_suffix("")
    return "prompt_agent." + ".".join(relative.parts)


def package_imports(path: pathlib.Path, known_modules: set[str]) -> set[str]:
    module = module_name(path)
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    deps: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.name
                if name in known_modules:
                    deps.add(name)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base_parts = module.split(".")[:-node.level]
                if node.module:
                    base_parts.extend(node.module.split("."))
                base = ".".join(base_parts)
            else:
                base = node.module or ""
            if base in known_modules:
                deps.add(base)
            for alias in node.names:
                candidate = f"{base}.{alias.name}" if base else alias.name
                if candidate in known_modules:
                    deps.add(candidate)
    deps.discard(module)
    return deps


def find_cycle(graph: dict[str, set[str]]) -> list[str]:
    visiting: set[str] = set()
    visited: set[str] = set()
    stack: list[str] = []

    def visit(node: str) -> list[str]:
        if node in visiting:
            start = stack.index(node)
            return stack[start:] + [node]
        if node in visited:
            return []
        visiting.add(node)
        stack.append(node)
        for dep in sorted(graph.get(node, set())):
            cycle = visit(dep)
            if cycle:
                return cycle
        stack.pop()
        visiting.remove(node)
        visited.add(node)
        return []

    for node in sorted(graph):
        cycle = visit(node)
        if cycle:
            return cycle
    return []


class ArchitectureTests(unittest.TestCase):
    def test_source_files_stay_under_line_limit(self):
        oversized = []
        for path in source_files():
            lines = path.read_text(encoding="utf-8").splitlines()
            if len(lines) > 1000:
                oversized.append(f"{path.relative_to(ROOT)}: {len(lines)}")
        self.assertEqual([], oversized)

    def test_package_import_graph_has_no_cycles(self):
        files = sorted(PACKAGE.rglob("*.py"))
        known_modules = {module_name(path) for path in files}
        graph = {module_name(path): package_imports(path, known_modules) for path in files}
        cycle = find_cycle(graph)
        self.assertEqual([], cycle)

    def test_active_tree_has_no_archived_runtime_execution_markers(self):
        matches = []
        for path in source_files():
            relative = path.relative_to(ROOT)
            if relative in HISTORICAL_FILES or relative.name == "test_architecture.py":
                continue
            text = path.read_text(encoding="utf-8")
            for marker in sorted(ARCHIVED_RUNTIME_MARKERS):
                if marker in text:
                    matches.append(f"{relative}: {marker}")
        self.assertEqual([], matches)

    def test_active_tree_has_no_archived_technical_names(self):
        matches = []
        for path in source_files():
            relative = path.relative_to(ROOT)
            if relative in HISTORICAL_FILES or relative in NAMING_COMPATIBILITY_FILES or relative.name == "test_architecture.py":
                continue
            text = path.read_text(encoding="utf-8")
            for marker in sorted(ARCHIVED_TECHNICAL_NAME_MARKERS):
                if marker in text:
                    matches.append(f"{relative}: {marker}")
        self.assertEqual([], matches)

if __name__ == "__main__":
    unittest.main()
