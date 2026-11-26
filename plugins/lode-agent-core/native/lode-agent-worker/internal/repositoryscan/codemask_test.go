package repositoryscan

import "testing"

// The same cases as test/source-scan-lexer.test.mjs: text the plain quote scan
// misread, each followed by declarations that must be found.
func TestLexerKeepsDeclarationsAfterTemplatesRegexAndComments(t *testing.T) {
	cases := []string{
		// template inside a template
		"const a = `outer ${`inner ${x}`} end`;\n",
		// regex after =
		"const b = /[\"'`]/g;\n",
		// regex after (
		"const c = text.replace(/[\"'`]/g, \"\");\n",
		// regex after return
		"function d(s) { return /[\"'`]/.test(s); }\n",
		// regex after return and a wide space
		"function d(s) { return\u00a0/'/.test(s); }\n",
		// template with quotes
		"const e = `${map[\"key\"] + 'x'}`;\n",
		// block comment with quotes
		"/* it's \"quoted\" and `ticked` \U0001F600 */\n",
		// string containing //
		"const f = \"http://example.test\";\n",
	}
	for label, prefix := range cases {
		text := prefix + "function after() { return helper(); }\nfunction helper() { return 1; }\n"
		found := map[string]bool{}
		for _, value := range extractSymbols(text, "javascript", newlineOffsets(text)) {
			found[value.(map[string]any)["name"].(string)] = true
		}
		if !found["after"] || !found["helper"] {
			t.Fatalf("case %d: declarations lost: %#v", label, found)
		}
	}
}

func TestLexerReadsGeneratorsAndUntrustedFiles(t *testing.T) {
	text := "export function* rows() { yield next(); }\nfunction next() {}\n"
	symbols := extractSymbols(text, "javascript", newlineOffsets(text))
	if len(symbols) != 2 || symbols[0].(map[string]any)["name"] != "rows" {
		t.Fatalf("generator declaration not found: %#v", symbols)
	}
	if _, trusted := javascriptCodeMask("const open = `never closed\n"); trusted {
		t.Fatal("a file ending inside a template must not be trusted")
	}
	if _, trusted := javascriptCodeMask("const a = `x ${y} z`;\n"); !trusted {
		t.Fatal("a closed template must be trusted")
	}
}
