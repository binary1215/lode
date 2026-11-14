package repositoryscan

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/binary1215/lode/native/lode-agent-worker/internal/canonicaljson"
)

func TestTrackedCorpusMatchesReviewedIdentity(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve repository scan test source")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", "..", "benchmarks", "repository-scan-v1", "basic"))
	result, operationFailure := Scan(FixtureInput(root, []string{}), Limits{
		MaxFiles: 20000, MaxFileBytes: 512 * 1024, MaxTotalBytes: 256 * 1024 * 1024,
	})
	if operationFailure != nil {
		t.Fatal(operationFailure)
	}
	document := result.(map[string]any)
	// Source analysis 0.3.1 deliberately changes aggregate identity even when
	// ASCII file facts are unchanged. Independently matched to the JS producer.
	if document["scanId"] != "repository-scan-6feed2133bb5f04eb779efee" {
		t.Fatalf("unexpected scan identity: %v", document["scanId"])
	}
	summary := document["summary"].(map[string]any)
	if summary["fileCount"] != 10 || summary["symbolCount"].(int) < 1 || summary["bindingCount"].(int) < 1 {
		t.Fatalf("unexpected scan summary: %#v", summary)
	}
	skipped := document["skipped"].(map[string]any)
	if skipped["excludedDirectory"] != 1 || skipped["unsupportedType"] != 1 {
		t.Fatalf("unexpected skipped counts: %#v", skipped)
	}
}

func TestTrackedCorpusHonorsExplicitSourceScope(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve repository scan test source")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", "..", "benchmarks", "repository-scan-v1", "basic"))
	result, operationFailure := Scan(FixtureInputWithScope(root, []string{}, []any{"src"}, []any{"src/tool.py"}), Limits{
		MaxFiles: 20000, MaxFileBytes: 512 * 1024, MaxTotalBytes: 256 * 1024 * 1024,
	})
	if operationFailure != nil {
		t.Fatal(operationFailure)
	}
	document := result.(map[string]any)
	summary := document["summary"].(map[string]any)
	if summary["fileCount"] != 2 {
		t.Fatalf("unexpected scoped summary: %#v", summary)
	}
	skipped := document["skipped"].(map[string]any)
	if skipped["outsideSourceScope"].(int) < 1 {
		t.Fatalf("source-scope exclusions were not recorded: %#v", skipped)
	}
}

func TestRepositoryScanExcludesCachesAndExplicitEvidenceScope(t *testing.T) {
	root := t.TempDir()
	for _, relative := range []string{".agent-work", "src/.agent-work", "src/nested/.AGENT-WORK"} {
		if err := os.MkdirAll(filepath.Join(root, relative), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, relative, "evidence.md"), []byte("work evidence"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, relative := range []string{"src", ".uv-python/lib", ".uv-cache/archive", ".pytest_cache/state", ".generated-evidence/evidence", ".github", ".custom-source"} {
		if err := os.MkdirAll(filepath.Join(root, relative), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, relative := range []string{"src/app.py", ".uv-python/lib/runtime.py", ".uv-cache/archive/runtime.py", ".pytest_cache/state/cache.py", ".generated-evidence/evidence/copy.py", ".github/workflow.yml", ".custom-source/module.py"} {
		if err := os.WriteFile(filepath.Join(root, relative), []byte("value = 1\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	unscoped, operationFailure := Scan(FixtureInput(root, []string{}), Limits{
		MaxFiles: 20000, MaxFileBytes: 512 * 1024, MaxTotalBytes: 256 * 1024 * 1024,
	})
	if operationFailure != nil {
		t.Fatal(operationFailure)
	}
	if unscoped.(map[string]any)["summary"].(map[string]any)["fileCount"] != 4 {
		t.Fatal("unlisted dot directories must remain eligible")
	}
	result, operationFailure := Scan(FixtureInputWithScope(root, []string{}, []any{}, []any{".generated-evidence"}), Limits{
		MaxFiles: 20000, MaxFileBytes: 512 * 1024, MaxTotalBytes: 256 * 1024 * 1024,
	})
	if operationFailure != nil {
		t.Fatal(operationFailure)
	}
	document := result.(map[string]any)
	summary := document["summary"].(map[string]any)
	skipped := document["skipped"].(map[string]any)
	if summary["fileCount"] != 3 || skipped["excludedDirectory"] != 6 || skipped["outsideSourceScope"] != 1 {
		t.Fatalf("technical runtime, cache, or evidence directories entered product evidence: summary=%#v skipped=%#v", summary, skipped)
	}
}

func TestSourceAnalysisUsesExactDeclarationRanges(t *testing.T) {
	python := "def f():\n    return 1\n"
	pythonSymbols := extractSymbols(python, "python", newlineOffsets(python))
	if len(pythonSymbols) != 1 || pythonSymbols[0].(map[string]any)["endLine"] != 3 {
		t.Fatalf("Python trailing-line range diverged from the canonical source analysis: %#v", pythonSymbols)
	}

	javascript := "function f() {} f();"
	javascriptCalls := extractCalls(javascript, "javascript", newlineOffsets(javascript))
	if len(javascriptCalls) != 1 {
		t.Fatalf("unexpected JavaScript calls: %#v", javascriptCalls)
	}
	call := javascriptCalls[0].(map[string]any)
	if call["callee"] != "f" || call["callerQualifiedName"] != nil || call["callerIdentityAmbiguous"] != false {
		t.Fatalf("top-level call was incorrectly attributed to a closed declaration: %#v", call)
	}
}

func TestUnmatchedBodyKeepsCanonicalJavaScriptHeader(t *testing.T) {
	for _, item := range []struct{ name, language, text, signature string }{
		{"balanced", "javascript", "export function balanced() { return 1; }", "export function balanced()"},
		{"unclosed", "javascript", "export function unclosed() {\n return 1;\n", "export function unclosed()"},
		{"regex-brace", "javascript", `export function regexBrace() { return /\{/; }`, "export function regexBrace()"},
		{"arrow", "typescript", "export const arrow = () => {\n return 1;\n", "export const arrow = () =>"},
		{"class", "javascript", "export class Unclosed {\n method() { return 1; }\n", "export class Unclosed"},
	} {
		t.Run(item.name, func(t *testing.T) {
			symbols := extractSymbols(item.text, item.language, newlineOffsets(item.text))
			if len(symbols) != 1 || symbols[0].(map[string]any)["signature"] != item.signature {
				t.Fatalf("header diverged from JS reference: %#v", symbols)
			}
			// This aligns the bounded observation, not a claim that malformed code
			// or brace-containing regex literals have been fully parsed.
		})
	}
}

func lodeScanFixture(t *testing.T, root string, managed []string) []byte {
	t.Helper()
	scope := map[string]any{
		"schemaVersion": 1, "kind": "RepositorySourceScope",
		"protocol":     map[string]any{"name": "lode-agent-core-repository-source-scope", "version": "0.1.0"},
		"includeRoots": []any{}, "excludeRoots": []any{},
		"authority": "user-selected-observation-boundary", "instructionAuthority": false, "promotionAuthority": false,
	}
	canonical, err := canonicaljson.Marshal(scope)
	if err != nil {
		t.Fatal(err)
	}
	hash := digest(canonical)
	scope["sourceScopeHash"], scope["sourceScopeId"] = hash, "repository-source-scope-"+hash[:24]
	input, err := canonicaljson.Marshal(map[string]any{
		"schemaVersion": 1, "kind": "RepositoryScanInput", "projectRoot": filepath.Clean(root),
		"managedRootFiles": managed, "sourceScope": scope,
	})
	if err != nil {
		t.Fatal(err)
	}
	return input
}

func TestLodeRootExclusionRequiresCanonicalFamilyAndExactToken(t *testing.T) {
	root := t.TempDir()
	for _, relative := range []string{".lode", "src/.lode", ".head"} {
		if err := os.MkdirAll(filepath.Join(root, relative), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, relative, "record.md"), []byte("source\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, item := range []struct {
		name       string
		canonical  bool
		managed    []string
		files      int
		exclusions int
	}{
		{"legacy-token-is-not-directory-exclusion", false, []string{".lode"}, 2, 1},
		{"canonical-unowned-root-visible", true, []string{}, 2, 1},
		{"canonical-exact-owned-root", true, []string{".lode"}, 1, 2},
		{"canonical-nested-token-does-not-exclude", true, []string{"src/.lode"}, 2, 1},
	} {
		t.Run(item.name, func(t *testing.T) {
			input := FixtureInput(root, item.managed)
			producer := ProducerName
			if item.canonical {
				input, producer = lodeScanFixture(t, root, item.managed), LodeProducerName
			}
			result, failure := Scan(input, Limits{MaxFiles: 20, MaxFileBytes: 4096, MaxTotalBytes: 16384})
			if failure != nil {
				t.Fatal(failure)
			}
			document := result.(map[string]any)
			files, skipped := document["files"].([]any), document["skipped"].(map[string]any)
			if len(files) != item.files || skipped["excludedDirectory"] != item.exclusions || skipped["managedProjection"] != 0 || skipped["outsideSourceScope"] != 0 || document["protocol"].(map[string]any)["name"] != producer {
				t.Fatalf("unexpected family/coverage/counters: %#v", document)
			}
			foundNested := false
			for _, file := range files {
				foundNested = foundNested || file.(map[string]any)["path"] == "src/.lode/record.md"
			}
			if !foundNested {
				t.Fatal("nested .lode source disappeared")
			}
		})
	}
}

func TestSourceScopeOriginalDigestIsVerifiedBeforeScan(t *testing.T) {
	input := lodeScanFixture(t, t.TempDir(), []string{".lode"})
	var payload map[string]any
	if err := json.Unmarshal(input, &payload); err != nil {
		t.Fatal(err)
	}
	payload["sourceScope"].(map[string]any)["protocol"].(map[string]any)["name"] = "head-agent-core-repository-source-scope"
	encoded, err := canonicaljson.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := Scan(encoded, Limits{MaxFiles: 20, MaxFileBytes: 4096, MaxTotalBytes: 16384, ExpectedProducer: LodeProducerName}); failure == nil || failure.Code != "REPOSITORY_SOURCE_SCOPE_DIGEST_MISMATCH" {
		t.Fatalf("expected original scope digest rejection, got %v", failure)
	}
}

func TestWindowsOwnedRootCaseAliasRequiresPhysicalIdentity(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows case-alias identity; distinct POSIX spelling is tested separately")
	}
	root := t.TempDir()
	for _, relative := range []string{".lode", "src/.LODE"} {
		if err := os.MkdirAll(filepath.Join(root, relative), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, relative, "record.md"), []byte("source\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	intermediate := filepath.Join(root, "rename-owned-root")
	if err := os.Rename(filepath.Join(root, ".lode"), intermediate); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(intermediate, filepath.Join(root, ".LODE")); err != nil {
		t.Fatal(err)
	}
	logical, err := os.Lstat(filepath.Join(root, ".lode"))
	if os.IsNotExist(err) {
		t.Skip("actual Windows test directory is case-sensitive; distinct-case preservation is tested separately")
	}
	if err != nil {
		t.Fatal(err)
	}
	physical, err := os.Lstat(filepath.Join(root, ".LODE"))
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(logical, physical) {
		t.Fatal("case-alias fixture is not the same physical directory")
	}
	for _, item := range []struct {
		name      string
		canonical bool
		managed   []string
		files     int
	}{
		{"owned-case-alias", true, []string{".lode"}, 1},
		{"legacy-token-keeps-case-alias", false, []string{".lode"}, 2},
		{"canonical-without-token-keeps-case-alias", true, []string{}, 2},
	} {
		t.Run(item.name, func(t *testing.T) {
			input := FixtureInput(root, item.managed)
			if item.canonical {
				input = lodeScanFixture(t, root, item.managed)
			}
			result, failure := Scan(input, Limits{MaxFiles: 20, MaxFileBytes: 4096, MaxTotalBytes: 16384})
			if failure != nil {
				t.Fatal(failure)
			}
			document := result.(map[string]any)
			files := document["files"].([]any)
			if len(files) != item.files {
				t.Fatalf("unexpected case-alias source coverage: %#v", document)
			}
			foundNested := false
			for _, file := range files {
				foundNested = foundNested || file.(map[string]any)["path"] == "src/.LODE/record.md"
			}
			if !foundNested || document["skipped"].(map[string]any)["excludedDirectory"] != 2-item.files {
				t.Fatalf("nested source or exclusion counter changed: %#v", document)
			}
		})
	}
}

func TestDistinctCaseRootRemainsSource(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".lode"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, ".LODE"), 0o755); err != nil {
		if os.IsExist(err) {
			t.Skip("this filesystem cannot represent distinct .lode and .LODE directories")
		}
		t.Fatal(err)
	}
	for _, relative := range []string{".lode", ".LODE"} {
		if err := os.WriteFile(filepath.Join(root, relative, "record.md"), []byte("source\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	result, failure := Scan(lodeScanFixture(t, root, []string{".lode"}), Limits{MaxFiles: 20, MaxFileBytes: 4096, MaxTotalBytes: 16384})
	if failure != nil {
		t.Fatal(failure)
	}
	document := result.(map[string]any)
	files := document["files"].([]any)
	if len(files) != 1 || files[0].(map[string]any)["path"] != ".LODE/record.md" || document["skipped"].(map[string]any)["excludedDirectory"] != 1 {
		t.Fatalf("distinct physical case variant disappeared: %#v", document)
	}
}
