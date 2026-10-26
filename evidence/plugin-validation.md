# Plugin detection validation: real public pages (2026-10-26)

**Method.** I saved 116 real, public WordPress pages (contact pages and homepages) with a single GET each. Ground truth was labelled **manually** by reading each page's HTML. A page counts as a positive for a plugin only if it has the plugin's actual `<form>` element (`wpforms-form`, `id="gform_N"`, `elementor-form`). Two things were labelled as **non-forms**: plugin JS or CSS with no form, and wrapper divs with no `<form>`. Then `checker.detect_forms()` was run on the saved HTML. Live `checker.check()` was run on every positive page.
Per-URL labels are kept privately, because some URLs came from prospect crawling. Only aggregates appear here.

## Detection (saved HTML; 111 labelled pages; 5 excluded as unverifiable: 1× HTTP 403, 4× ambiguous wrapper-without-form/lazy render)
| Plugin | Positives | TP | FP | FN | TN | Precision | Recall |
|---|---|---|---|---|---|---|---|
| WPForms | 18 | 18 | 0 | 0 | 93 | 100% | 100% |
| Gravity Forms | 22 | 22 | 0 | 0 | 89 | 100% | 100% |
| Elementor Forms | 21 | 21 | 0 | 0 | 90 | 100% | 100% |

The negatives include traps: Elementor JS with no form (8 pages), Ninja Forms (7), Constant Contact, HubSpot, Zoho and iframe embeds, Divi and Flodesk.

## Live full check on the 61 positive pages
- 58 **OK**.
- 2 **UNVERIFIABLE**: `admin-ajax.php` returned 403.
- 1 was **FAIL** `script_not_referenced` on the first run. That was a **false positive**: LiteSpeed Cache combines the JS into one bundle. **Fix:** an optimizer bundle (LiteSpeed, Autoptimize, WP Rocket, SiteGround Optimizer, WP-Optimize, Divi cache) now gives UNVERIFIABLE. Re-run: UNVERIFIABLE. Regression test added.
- Result after the fix: **0 false FAILs** on 61 pages that have a form.

## Limits (honest)
- The labels and the detector both rely on the same server-rendered markup. Forms injected only by JavaScript, or inside popups, are not covered. Those 4 cases were excluded, not counted.
- n≈20 per plugin. "100%" means 0 errors in this sample. It is not a guarantee.
- This is presence and reachability only. Nothing here verifies that a submission succeeds or that a lead is delivered.
- CF7, Ninja, Fluent, Formidable and generic forms stay **experimental** until they have a set like this one.
