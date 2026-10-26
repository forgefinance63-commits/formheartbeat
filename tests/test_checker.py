import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import checker
F = os.path.join(os.path.dirname(__file__), "fixtures")
def fx(n): return open(os.path.join(F, n)).read()
def fake(page_html, page_status=200, script=200, rest=200, calls=None):
    def f(url, method):
        if calls is not None: calls.append((method, url))
        if "contact-form-7/includes" in url: return {"status": script, "body": "", "ms": 1, "error": None}
        if "/wp-json/" in url: return {"status": rest, "body": "", "ms": 1, "error": None}
        return {"status": page_status, "body": page_html, "ms": 1, "error": None}
    return f
U = "https://example.test/contact/"
class T(unittest.TestCase):
    def test_present_ok(self):
        calls = []
        r = checker.check(U, fake(fx("present.html"), calls=calls))
        self.assertEqual(r["result"], "OK", r)
        self.assertEqual(r["checks"]["cf7"]["cf7_form_count"], 1)
        self.assertTrue(all(m in ("GET", "HEAD") for m, _ in calls))
        self.assertEqual(sum(1 for m, u in calls if u == U), 1)  # single page GET
    def test_missing(self):
        r = checker.check(U, fake(fx("missing.html")))
        self.assertIn("cf7_form_missing", r["problems"])
    def test_broken_no_submit_no_script(self):
        r = checker.check(U, fake(fx("broken.html")))
        self.assertIn("submit_control_missing", r["problems"])
        self.assertIn("cf7_script_not_referenced", r["problems"])
    def test_page_500(self):
        r = checker.check(U, fake("", page_status=500))
        self.assertEqual(r["problems"], ["page_status:500"])
    def test_script_404(self):
        r = checker.check(U, fake(fx("present.html"), script=404))
        self.assertIn("script_status:404", r["problems"])
    def test_rest_locked_is_ok_but_404_fails(self):
        self.assertEqual(checker.check(U, fake(fx("present.html"), rest=401))["result"], "OK")
        self.assertIn("rest_base_status:404", checker.check(U, fake(fx("present.html"), rest=404))["problems"])
if __name__ == "__main__": unittest.main()
