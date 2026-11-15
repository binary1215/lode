package repositoryscan

import (
	"regexp"
	"strings"
)

// Import clauses whatever their layout, ported from extractImportBindings in
// scripts/lib/world/source-analysis.mjs: comments and line breaks are dropped
// first, so a list spread over lines reads like one on a line.
var (
	javascriptImportLayout = jsRegexp(`\bimport\s+((?:type\s+)?(?:[A-Za-z_$][A-Za-z0-9_$]*\s*,\s*)?(?:\*\s*as\s+[A-Za-z_$][A-Za-z0-9_$]*|\{[^}]*\}))\s*from\s*["']([^"']+)["']`)
	importBlockComment     = regexp.MustCompile(`(?s)/\*.*?\*/`)
	importLineComment      = regexp.MustCompile(`//[^\n]*`)
	importWhiteSpace       = jsRegexp(`\s+`)

	// Python: "from m import" followed by a list, a parenthesised list over
	// lines, or a line continued with a backslash.
	pythonFromLayout   = jsRegexp(`(?m)^[ \t]*from\s+([.A-Za-z_][A-Za-z0-9_.]*)\s+import[ \t]+`)
	pythonLineComment  = regexp.MustCompile(`#[^\n]*`)
	pythonContinued    = jsRegexp(`\\\s*$`)
	pythonContinuation = jsRegexp(`\\\s*\n`)
)

func normalizedImportClause(clause string) string {
	clause = importBlockComment.ReplaceAllString(clause, " ")
	clause = importLineComment.ReplaceAllString(clause, " ")
	return strings.TrimSpace(importWhiteSpace.ReplaceAllString(clause, " "))
}
