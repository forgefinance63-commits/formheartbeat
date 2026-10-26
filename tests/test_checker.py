import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import checker
F = os.path.join(os.path.dirname(__file__), "fixtures")
def fx(n): return open(os.path.join(F, n)).read()
def fake(page_html, page_status=200, script=200, rest=200, calls=None, ajax=400):
    def f(url, method):
        if calls is not None: calls.append((method, url))
        if "/wp-content/plugins/" in url: return {"status": script, "body": "", "ms": 1, "error": None}
        if "admin-ajax.php" in url: return {"status": ajax, "body": "0", "ms": 1, "error": None}
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
        self.assertEqual(r["plugins"], ["cf7"])
        self.assertTrue(all(m in ("GET", "HEAD") for m, _ in calls))
        self.assertEqual(sum(1 for m, u in calls if u == U), 1)  # single page GET
    def test_missing(self):
        r = checker.check(U, fake(fx("missing.html")))
        self.assertIn("contact_form_missing", r["problems"])
    def test_broken_no_submit_no_script(self):
        r = checker.check(U, fake(fx("broken.html")))
        self.assertIn("cf7:submit_control_missing", r["problems"])
        self.assertIn("cf7:script_not_referenced", r["problems"])
    def test_page_500(self):
        r = checker.check(U, fake("", page_status=500))
        self.assertEqual(r["problems"], ["page_status:500"])
    def test_script_404(self):
        r = checker.check(U, fake(fx("present.html"), script=404))
        self.assertIn("cf7:script_status:404", r["problems"])
    def test_rest_classes(self):
        self.assertEqual(checker.check(U, fake(fx("present.html"), rest=200))["rest_class"], "reachable")
        for code in (401, 403):
            r = checker.check(U, fake(fx("present.html"), rest=code))
            self.assertEqual((r["result"], r["rest_class"]), ("WARN", "protected"))
        self.assertIn("cf7_rest_status:404", checker.check(U, fake(fx("present.html"), rest=404))["problems"])
    def test_rest_baseline_change_fails(self):
        r = checker.check(U, fake(fx("present.html"), rest=403), baseline={"rest_class": "reachable"})
        self.assertEqual(r["result"], "FAIL"); self.assertIn("rest_baseline_changed:reachable->protected", r["problems"])
        r = checker.check(U, fake(fx("present.html"), rest=403), baseline={"rest_class": "protected"})
        self.assertEqual(r["result"], "WARN")
    def test_plugins_detected_ok(self):
        for name in ("wpforms", "gravity", "elementor", "ninja", "fluent", "generic"):
            calls = []
            r = checker.check(U, fake(fx(name + ".html"), calls=calls))
            self.assertEqual((r["plugins"], r["result"]), ([name], "OK"), (name, r))
            self.assertTrue(all(m in ("GET", "HEAD") for m, _ in calls))
    def test_elementor_free_runtime_counts_as_asset(self):
        h = fx("elementor.html").replace("/elementor-pro/assets/js/frontend.min.js", "/elementor/assets/js/webpack.runtime.min.js")
        self.assertEqual(checker.check(U, fake(h))["result"], "OK")
    def test_plugin_asset_404_fails(self):
        for name in ("wpforms", "elementor", "ninja", "fluent", "gravity"):
            r = checker.check(U, fake(fx(name + ".html"), script=404))
            self.assertIn(f"{name}:script_status:404", r["problems"], name)
    def test_ajax_endpoint_protected_warn(self):
        r = checker.check(U, fake(fx("wpforms.html"), ajax=403))
        self.assertEqual(r["result"], "WARN"); self.assertIn("ajax_protected:403 (cannot verify)", r["warnings"])
        self.assertEqual(checker.check(U, fake(fx("wpforms.html"), ajax=500))["result"], "FAIL")
    def test_plugin_change_vs_baseline(self):
        r = checker.check(U, fake(fx("generic.html")), baseline={"verified": True, "plugins": ["wpforms"]})
        self.assertIn("form_plugin_changed:wpforms->generic", r["problems"])
    def test_challenges_warn_never_fail(self):
        for f, st, vendor in (("ch_sgcaptcha", 202, "siteground_sgcaptcha"), ("ch_cloudflare", 403, "cloudflare"),
                              ("ch_cloudflare", 503, "cloudflare"), ("ch_sucuri", 403, "sucuri"), ("ch_generic", 202, "generic"),
                              ("ch_sgcaptcha", 200, "siteground_sgcaptcha"), ("ch_modsec", 406, "modsecurity")):
            r = checker.check(U, fake(fx(f + ".html"), page_status=st))
            self.assertEqual((r["result"], r["challenge"]), ("WARN", vendor), (f, st, r))
            self.assertEqual(r["problems"], [])
    def test_plain_403_without_markers_is_fail(self):
        self.assertEqual(checker.check(U, fake("<html>Forbidden</html>", page_status=403))["result"], "FAIL")
    def test_turnstile_script_on_real_page_not_challenge(self):
        r = checker.check(U, fake(fx("cf_turnstile_ok.html")))
        self.assertIsNone(r["challenge"]); self.assertEqual(r["result"], "OK")
    def test_challenge_persistent_and_changed_alerts(self):
        b = checker.update_baseline({}, checker.check(U, fake(fx("wpforms.html"))))
        self.assertTrue(b["verified"])
        results = []
        for _ in range(3):
            r = checker.check(U, fake(fx("ch_sgcaptcha.html"), page_status=202), baseline=b)
            b = checker.update_baseline(b, r); results.append(r["result"])
        self.assertEqual(results, ["WARN", "WARN", "FAIL"])
        # never-verified site (always challenged) never fails
        b2 = {}
        for _ in range(5):
            r = checker.check(U, fake(fx("ch_cloudflare.html"), page_status=403), baseline=b2); b2 = checker.update_baseline(b2, r)
            self.assertEqual(r["result"], "WARN")
        # recovery resets streak
        b = checker.update_baseline(b, checker.check(U, fake(fx("wpforms.html"))))
        self.assertEqual(b["challenge_streak"], 0)
    def test_scan_site_all_contact_pages(self):
        home = '<a href="/contact-us/">C</a><a href="/request-a-quote/">Q</a><a href="/about/">A</a>'
        pages = {"https://ex.test/": home, "https://ex.test/contact-us/": fx("gravity.html"), "https://ex.test/request-a-quote/": fx("wpforms.html")}
        seen = []
        def f(url, method):
            seen.append(url)
            if "/wp-content/plugins/" in url: return {"status": 200, "body": "", "ms": 1, "error": None}
            if "admin-ajax" in url: return {"status": 400, "body": "0", "ms": 1, "error": None}
            b = pages.get(url); return {"status": 200 if b is not None else 404, "body": b or "", "ms": 1, "error": None}
        s = checker.scan_site("https://ex.test/", f)
        self.assertEqual(sorted(s["form_pages"]), ["https://ex.test/contact-us/", "https://ex.test/request-a-quote/"])
        self.assertEqual(s["plugins"], ["gravity", "wpforms"])
        for p in ("/contact/", "/get-in-touch/", "/quote/"): self.assertIn("https://ex.test" + p, seen)
        self.assertNotIn("https://ex.test/about/", seen)
if __name__ == "__main__": unittest.main()
