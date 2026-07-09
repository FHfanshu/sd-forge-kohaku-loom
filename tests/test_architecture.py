from __future__ import annotations

import ast
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "lib_qwen3vl_prompt_tools"
TEXT_SUFFIXES = {".css", ".js", ".json", ".md", ".py", ".txt", ".yaml", ".yml"}
SKIP_PARTS = {".git", ".pytest_cache", "__pycache__", "bin"}


def source_files() -> list[pathlib.Path]:
    result: list[pathlib.Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        if any(part in SKIP_PARTS for part in path.relative_to(ROOT).parts):
            continue
        result.append(path)
    return result


def module_name(path: pathlib.Path) -> str:
    relative = path.relative_to(PACKAGE).with_suffix("")
    return "lib_qwen3vl_prompt_tools." + ".".join(relative.parts)


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
        files = sorted(PACKAGE.glob("*.py"))
        known_modules = {module_name(path) for path in files}
        graph = {module_name(path): package_imports(path, known_modules) for path in files}
        cycle = find_cycle(graph)
        self.assertEqual([], cycle)

    def test_package_modules_do_not_import_generic_facade(self):
        offenders = []
        for path in sorted(PACKAGE.glob("*.py")):
            if path.name == "generic.py":
                continue
            deps = package_imports(path, {"lib_qwen3vl_prompt_tools.generic"})
            if deps:
                offenders.append(str(path.relative_to(ROOT)))
        self.assertEqual([], offenders)


if __name__ == "__main__":
    unittest.main()
