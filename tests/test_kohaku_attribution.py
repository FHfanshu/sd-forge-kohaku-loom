import unittest
from pathlib import Path


class KohakuAttributionTests(unittest.TestCase):
    def test_license_and_visible_attribution_are_distributed(self):
        root = Path(__file__).resolve().parents[1]
        license_text = (root / "LICENSE").read_text(encoding="utf-8")
        readme = (root / "README.md").read_text(encoding="utf-8")
        frontend = (root / "frontend" / "src" / "components" / "ProfileSettings.svelte").read_text(encoding="utf-8")
        official_url = "https://github.com/Kohaku-Lab/KohakuTerrarium"

        self.assertIn("KohakuTerrarium License", license_text)
        self.assertIn("KohakuTerrarium", readme)
        self.assertIn(official_url, readme)
        self.assertIn("Powered by", frontend)
        self.assertIn(official_url, frontend)


if __name__ == "__main__":
    unittest.main()
