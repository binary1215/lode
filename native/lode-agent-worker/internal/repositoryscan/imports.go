package repositoryscan

import (
	"regexp"
	"strings"
)

// Import clauses whatever their layout, ported from extractImportBindings in
// scripts/lib/world/source-analysis.mjs: comments and line breaks are dropped
// first, so a list spread over lines reads like one on a line.
var (
	javascriptImportLayout = regexp.MustCompile(`\bimport\s+((?:type\s+)?(?:[A-Za-z_$][A-Za-z0-9_$]*\s*,\s*)?(?:\*\s*as\s+[A-Za-z_$][A-Za-z0-9_$]*|\{[^}]*\}))\s*from\s*["']([^"']+)["']`)
	importBlockComment     = regexp.MustCompile(`(?s)/\*.*?\*/`)
	importLineComment      = regexp.MustCompile(`//[^\n]*`)
	importWhiteSpace       = regexp.MustCompile(`\s+`)
)

func normalizedImportClause(clause string) string {
	clause = importBlockComment.ReplaceAllString(clause, " ")
	clause = importLineComment.ReplaceAllString(clause, " ")
	return strings.TrimSpace(importWhiteSpace.ReplaceAllString(clause, " "))
}
