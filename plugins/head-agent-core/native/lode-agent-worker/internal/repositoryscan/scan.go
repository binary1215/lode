// Package repositoryscan implements repository.scan.v1 with output semantics
// matching the JavaScript reference implementation.
package repositoryscan

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/binary1215/lode/native/lode-agent-worker/internal/canonicaljson"
)

const (
	Operation             = "repository.scan.v1"
	ProducerName          = "head-agent-core-repository-scan"
	LodeProducerName      = "lode-agent-core-repository-scan"
	ProducerVersion       = "0.5.1"
	SourceAnalysisVersion = "0.3.1"
	maximumSymbolsPerFile = 200
)

type Limits struct {
	MaxFiles      int
	MaxFileBytes  int
	MaxTotalBytes int
	// ExpectedProducer carries the validated compute envelope's family. It is
	// internal composition state, never an additional repository input field.
	ExpectedProducer string
}

type OperationError struct {
	Code    string
	Message string
}

func (e *OperationError) Error() string { return e.Message }

func operationError(code, message string) *OperationError {
	return &OperationError{Code: code, Message: message}
}

var (
	drivePathPattern = regexp.MustCompile(`^[A-Za-z]:`)
	identifier       = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

	javascriptFunction = regexp.MustCompile(`\b(export\s+)?(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)`)
	javascriptClass    = regexp.MustCompile(`\b(export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)`)
	javascriptBinding  = regexp.MustCompile(`\b(export\s+)?(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(async\s*)?(function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)`)
	pythonFunction     = regexp.MustCompile(`(?m)^[ \t]*(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)`)
	pythonClass        = regexp.MustCompile(`(?m)^[ \t]*class\s+([A-Za-z_][A-Za-z0-9_]*)`)
	markdownHeading    = regexp.MustCompile(`(?m)^#{1,6}\s+(.+?)\s*$`)

	javascriptDependency = regexp.MustCompile(`\b(from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']`)
	pythonDependency     = regexp.MustCompile(`(?m)^\s*(from|import)\s+([A-Za-z_][A-Za-z0-9_.]*)`)

	javascriptImport       = regexp.MustCompile(`\bimport\s+([^;\n]+?)\s+from\s+["']([^"']+)["']`)
	javascriptNamespace    = regexp.MustCompile(`^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$`)
	javascriptNamed        = regexp.MustCompile(`\{([^}]+)\}`)
	javascriptAsSplit      = regexp.MustCompile(`\s+as\s+`)
	javascriptRequireNamed = regexp.MustCompile(`\b(const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)`)
	javascriptColonSplit   = regexp.MustCompile(`\s*:\s*`)
	javascriptRequire      = regexp.MustCompile(`\b(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)`)
	pythonFromImport       = regexp.MustCompile(`(?m)^[ \t]*from\s+([.A-Za-z_][A-Za-z0-9_.]*)\s+import\s+([^#\n]+)`)
	pythonAsSplit          = regexp.MustCompile(`\s+as\s+`)
	pythonImport           = regexp.MustCompile(`(?m)^[ \t]*import\s+([A-Za-z_][A-Za-z0-9_.]*)(\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?`)
	callPattern            = regexp.MustCompile(`\b([A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)?)\s*\(`)
	declarationPrefix      = regexp.MustCompile(`\b(function|class|def|new)\s*$`)
)

var excludedDirectories = map[string]bool{
	".agent-work": true,
	".cache":      true, ".git": true, ".head": true, ".hg": true, ".mypy_cache": true,
	".next": true, ".nox": true, ".nuxt": true,
	".pytest_cache": true, ".ruff_cache": true, ".svn": true, ".tox": true,
	".uv-cache": true, ".uv-python": true,
	".venv": true, "__pycache__": true, "build": true, "coverage": true,
	"dist": true, "node_modules": true, "out": true, "target": true,
	"vendor": true, "venv": true,
}

var textExtensions = map[string]bool{
	".c": true, ".cc": true, ".cpp": true, ".cs": true, ".css": true,
	".go": true, ".h": true, ".hpp": true, ".html": true, ".java": true,
	".js": true, ".jsx": true, ".json": true, ".kt": true, ".kts": true,
	".md": true, ".mjs": true, ".mts": true, ".php": true, ".ps1": true,
	".py": true, ".rb": true, ".rs": true, ".sh": true, ".sql": true,
	".svelte": true, ".toml": true, ".ts": true, ".tsx": true, ".txt": true,
	".vue": true, ".xml": true, ".yaml": true, ".yml": true,
}

func digest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func decodeStrictObject(data []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var value map[string]json.RawMessage
	if err := decoder.Decode(&value); err != nil || value == nil {
		return nil, fmt.Errorf("input is not an object")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, fmt.Errorf("input contains trailing JSON")
	}
	return value, nil
}

func normalizedRelativePath(value string) bool {
	if value == "" || strings.ContainsRune(value, 0) || strings.Contains(value, `\`) || strings.HasPrefix(value, "/") || drivePathPattern.MatchString(value) {
		return false
	}
	normalized := path.Clean(value)
	return normalized == value && normalized != "." && normalized != ".." && !strings.HasPrefix(normalized, "../")
}

type scanInput struct {
	SchemaVersion    int
	Kind             string
	ProjectRoot      string
	ManagedRootFiles []string
	SourceScope      map[string]any
	IncludeRoots     []string
	ExcludeRoots     []string
}

func parseScopeRoots(scope map[string]any, field string) ([]string, *OperationError) {
	values, ok := scope[field].([]any)
	if !ok {
		return nil, operationError("INVALID_REPOSITORY_SOURCE_SCOPE", field+" must be an array.")
	}
	result := make([]string, 0, len(values))
	seen := map[string]bool{}
	for index, value := range values {
		root, ok := value.(string)
		if !ok || !normalizedRelativePath(root) {
			return nil, operationError("INVALID_REPOSITORY_SOURCE_SCOPE_PATH", fmt.Sprintf("%s[%d] is not a normalized project-relative path.", field, index))
		}
		if seen[root] {
			return nil, operationError("INVALID_REPOSITORY_SOURCE_SCOPE", field+" contains duplicates.")
		}
		seen[root] = true
		result = append(result, root)
	}
	for index := 1; index < len(result); index++ {
		if canonicaljson.CompareText(result[index-1], result[index]) > 0 {
			return nil, operationError("INVALID_REPOSITORY_SOURCE_SCOPE", field+" is not canonically ordered.")
		}
	}
	return result, nil
}

func verifySourceScope(value json.RawMessage) (map[string]any, []string, []string, *OperationError) {
	var scope map[string]any
	if json.Unmarshal(value, &scope) != nil || scope == nil {
		return nil, nil, nil, operationError("INVALID_REPOSITORY_SOURCE_SCOPE", "Repository source scope must be an object.")
	}
	allowed := map[string]bool{
		"schemaVersion": true, "kind": true, "protocol": true, "includeRoots": true, "excludeRoots": true,
		"authority": true, "instructionAuthority": true, "promotionAuthority": true, "sourceScopeId": true, "sourceScopeHash": true,
	}
	for key := range scope {
		if !allowed[key] {
			return nil, nil, nil, operationError("INVALID_REPOSITORY_SOURCE_SCOPE", "Repository source scope contains unsupported fields.")
		}
	}
	protocol, protocolOK := scope["protocol"].(map[string]any)
	if scope["schemaVersion"] != float64(1) || scope["kind"] != "RepositorySourceScope" ||
		!protocolOK || (protocol["name"] != "head-agent-core-repository-source-scope" && protocol["name"] != "lode-agent-core-repository-source-scope") || protocol["version"] != "0.1.0" ||
		scope["authority"] != "user-selected-observation-boundary" || scope["instructionAuthority"] != false || scope["promotionAuthority"] != false {
		return nil, nil, nil, operationError("INVALID_REPOSITORY_SOURCE_SCOPE", "Repository source scope contract is invalid.")
	}
	includeRoots, includeError := parseScopeRoots(scope, "includeRoots")
	if includeError != nil {
		return nil, nil, nil, includeError
	}
	excludeRoots, excludeError := parseScopeRoots(scope, "excludeRoots")
	if excludeError != nil {
		return nil, nil, nil, excludeError
	}
	payload := map[string]any{}
	for key, item := range scope {
		if key != "sourceScopeId" && key != "sourceScopeHash" {
			payload[key] = item
		}
	}
	canonical, canonicalError := canonicaljson.Marshal(payload)
	if canonicalError != nil {
		return nil, nil, nil, operationError("INVALID_REPOSITORY_SOURCE_SCOPE", "Repository source scope cannot be encoded.")
	}
	hash := digest(canonical)
	if scope["sourceScopeHash"] != hash || scope["sourceScopeId"] != "repository-source-scope-"+hash[:24] {
		return nil, nil, nil, operationError("REPOSITORY_SOURCE_SCOPE_DIGEST_MISMATCH", "Repository source scope digest verification failed.")
	}
	return scope, includeRoots, excludeRoots, nil
}

func parseInput(data []byte) (scanInput, *OperationError) {
	raw, err := decodeStrictObject(data)
	if err != nil {
		return scanInput{}, operationError("INVALID_REPOSITORY_SCAN_SCHEMA", "Repository scan input must be an object.")
	}
	allowed := map[string]bool{"schemaVersion": true, "kind": true, "projectRoot": true, "managedRootFiles": true, "sourceScope": true}
	unexpected := make([]string, 0)
	for key := range raw {
		if !allowed[key] {
			unexpected = append(unexpected, key)
		}
	}
	sort.Slice(unexpected, func(left, right int) bool { return canonicaljson.CompareText(unexpected[left], unexpected[right]) < 0 })
	if len(unexpected) > 0 {
		return scanInput{}, operationError("INVALID_REPOSITORY_SCAN_SCHEMA", fmt.Sprintf("Repository scan input contains unsupported fields: %s", strings.Join(unexpected, ", ")))
	}
	var input scanInput
	if value, ok := raw["schemaVersion"]; ok {
		_ = json.Unmarshal(value, &input.SchemaVersion)
	}
	if value, ok := raw["kind"]; ok {
		_ = json.Unmarshal(value, &input.Kind)
	}
	if value, ok := raw["projectRoot"]; !ok || json.Unmarshal(value, &input.ProjectRoot) != nil || strings.TrimSpace(input.ProjectRoot) == "" || strings.ContainsRune(input.ProjectRoot, 0) {
		return scanInput{}, operationError("INVALID_REPOSITORY_SCAN_INPUT", "projectRoot is required.")
	}
	value, ok := raw["managedRootFiles"]
	if !ok || json.Unmarshal(value, &input.ManagedRootFiles) != nil || input.ManagedRootFiles == nil {
		return scanInput{}, operationError("INVALID_REPOSITORY_SCAN_INPUT", "managedRootFiles must be an array.")
	}
	seen := map[string]bool{}
	for index, managed := range input.ManagedRootFiles {
		if !normalizedRelativePath(managed) {
			return scanInput{}, operationError("INVALID_REPOSITORY_SCAN_PATH", fmt.Sprintf("managedRootFiles[%d] is not a normalized relative path.", index))
		}
		if seen[managed] {
			return scanInput{}, operationError("INVALID_REPOSITORY_SCAN_INPUT", "managedRootFiles contains duplicates.")
		}
		seen[managed] = true
	}
	sort.Slice(input.ManagedRootFiles, func(left, right int) bool {
		return canonicaljson.CompareText(input.ManagedRootFiles[left], input.ManagedRootFiles[right]) < 0
	})
	scopeValue, ok := raw["sourceScope"]
	if !ok {
		return scanInput{}, operationError("INVALID_REPOSITORY_SCAN_INPUT", "sourceScope is required.")
	}
	var scopeError *OperationError
	input.SourceScope, input.IncludeRoots, input.ExcludeRoots, scopeError = verifySourceScope(scopeValue)
	if scopeError != nil {
		return scanInput{}, scopeError
	}
	absolute, absErr := filepath.Abs(input.ProjectRoot)
	if absErr != nil {
		return scanInput{}, operationError("INVALID_REPOSITORY_SCAN_INPUT", "projectRoot is required.")
	}
	rebuilt := map[string]any{
		"schemaVersion":    1,
		"kind":             "RepositoryScanInput",
		"projectRoot":      filepath.Clean(absolute),
		"managedRootFiles": input.ManagedRootFiles,
		"sourceScope":      input.SourceScope,
	}
	canonicalRaw, rawErr := canonicaljson.Marshal(json.RawMessage(data))
	canonicalRebuilt, rebuiltErr := canonicaljson.Marshal(rebuilt)
	if rawErr != nil || rebuiltErr != nil || !bytes.Equal(canonicalRaw, canonicalRebuilt) {
		return scanInput{}, operationError("INVALID_REPOSITORY_SCAN_INPUT", "Repository scan input is not canonical.")
	}
	input.SchemaVersion = 1
	input.Kind = "RepositoryScanInput"
	input.ProjectRoot = filepath.Clean(absolute)
	return input, nil
}

func newlineOffsets(text string) []int {
	result := make([]int, 0)
	for index := 0; index < len(text); index++ {
		if text[index] == '\n' {
			result = append(result, index)
		}
	}
	return result
}

func lineAt(lines []int, byteIndex int) int {
	return 1 + sort.Search(len(lines), func(index int) bool { return lines[index] >= byteIndex })
}

type symbolPattern struct {
	Kind  string
	Regex *regexp.Regexp
	Group int
}

func regexSymbols(text string, lines []int, patterns []symbolPattern, maximum int) []any {
	result := make([]any, 0)
	for _, pattern := range patterns {
		for _, match := range pattern.Regex.FindAllStringSubmatchIndex(text, -1) {
			groupOffset := pattern.Group * 2
			if groupOffset+1 >= len(match) || match[groupOffset] < 0 {
				continue
			}
			name := text[match[groupOffset]:match[groupOffset+1]]
			line := lineAt(lines, match[0])
			result = append(result, map[string]any{
				"name":          name,
				"kind":          pattern.Kind,
				"line":          line,
				"startIndex":    match[0],
				"matchEndIndex": match[1],
			})
			if len(result) >= maximum {
				return sortSymbols(result)
			}
		}
	}
	return sortSymbols(result)
}

func normalizedSignature(value string) string {
	normalized := []rune(strings.Join(strings.Fields(value), " "))
	if len(normalized) > 500 {
		normalized = normalized[:500]
	}
	return string(normalized)
}

func sourceLines(text string) []string {
	return strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
}

func indentation(value string) int {
	count := 0
	for _, character := range value {
		if character == ' ' {
			count++
		} else if character == '\t' {
			count += 4
		} else {
			break
		}
	}
	return count
}

func braceEnd(text string, open int) int {
	if open < 0 || open >= len(text) || text[open] != '{' {
		return -1
	}
	depth := 0
	for index := open; index < len(text); index++ {
		if text[index] == '{' {
			depth++
		} else if text[index] == '}' {
			depth--
			if depth == 0 {
				return index
			}
		}
	}
	return -1
}

func pythonHeaderEnd(masked string, start int) int {
	depth := 0
	for index := start; index < len(masked); index++ {
		switch masked[index] {
		case '(', '[', '{':
			depth++
		case ')', ']', '}':
			if depth > 0 {
				depth--
			}
		case ':':
			if depth == 0 {
				return index + 1
			}
		}
	}
	return -1
}

func enrichSymbols(text, masked, language string, values []any, lines []int, includeRanges bool) []any {
	textLines := sourceLines(text)
	for _, value := range values {
		symbol := value.(map[string]any)
		line := symbol["line"].(int)
		start := symbol["startIndex"].(int)
		matchEnd := symbol["matchEndIndex"].(int)
		endLine := line
		scopePath := ""
		signature := ""
		if line > 0 && line <= len(textLines) {
			signature = normalizedSignature(strings.TrimSpace(textLines[line-1]))
		}
		if language == "javascript" || language == "typescript" {
			lineEnd := strings.IndexByte(masked[matchEnd:], '\n')
			if lineEnd < 0 {
				lineEnd = len(masked)
			} else {
				lineEnd += matchEnd
			}
			open := -1
			matched := masked[start:matchEnd]
			if symbol["kind"] == "binding" && strings.Contains(matched, "=>") {
				bodyStart := matchEnd
				for bodyStart < len(masked) && (masked[bodyStart] == ' ' || masked[bodyStart] == '\t' || masked[bodyStart] == '\r' || masked[bodyStart] == '\n') {
					bodyStart++
				}
				if bodyStart < len(masked) && masked[bodyStart] == '{' {
					open = bodyStart
				}
			} else if openRelative := strings.IndexByte(masked[matchEnd:], '{'); openRelative >= 0 && matchEnd+openRelative <= lineEnd+500 {
				open = matchEnd + openRelative
			}
			end := braceEnd(masked, open)
			if end >= 0 {
				endLine = lineAt(lines, end)
				signature = normalizedSignature(text[start:open])
				symbol["endIndex"] = end + 1
			} else {
				statementEnd := lineEnd
				if semicolon := strings.IndexByte(masked[matchEnd:lineEnd], ';'); semicolon >= 0 {
					statementEnd = matchEnd + semicolon + 1
				}
				endLine = lineAt(lines, statementEnd)
				headerEnd := statementEnd
				if open >= 0 {
					headerEnd = open
				}
				signature = normalizedSignature(text[start:headerEnd])
				symbol["endIndex"] = statementEnd
			}
		} else if language == "python" {
			headerEnd := pythonHeaderEnd(masked, start)
			if headerEnd < 0 {
				headerEnd = matchEnd
			}
			headerEndLine := lineAt(lines, headerEnd-1)
			signature = normalizedSignature(text[start:headerEnd])
			currentIndent := indentation(textLines[line-1])
			endLine = len(textLines)
			symbol["endIndex"] = len(masked)
			for after := headerEndLine; after < len(textLines); after++ {
				if strings.TrimSpace(textLines[after]) == "" {
					continue
				}
				if indentation(textLines[after]) <= currentIndent {
					endLine = after
					if after == 0 {
						symbol["endIndex"] = 0
					} else {
						symbol["endIndex"] = lines[after-1] + 1
					}
					break
				}
			}
		}
		symbol["endLine"] = endLine
		symbol["scopePath"] = scopePath
		symbol["qualifiedName"] = symbol["name"].(string)
		symbol["signature"] = signature
	}
	if language == "markdown" {
		headings := make([]string, 0, 6)
		for _, value := range values {
			symbol := value.(map[string]any)
			line := symbol["line"].(int)
			level := 1
			if line > 0 && line <= len(textLines) {
				level = 0
				for _, character := range textLines[line-1] {
					if character == '#' {
						level++
					} else {
						break
					}
				}
			}
			for len(headings) >= level {
				headings = headings[:len(headings)-1]
			}
			scope := strings.Join(headings, " / ")
			symbol["scopePath"] = scope
			if scope != "" {
				symbol["qualifiedName"] = scope + " / " + symbol["name"].(string)
			}
			headings = append(headings, symbol["name"].(string))
		}
	}
	if language == "python" || language == "javascript" || language == "typescript" {
		for _, value := range values {
			symbol := value.(map[string]any)
			containers := make([]map[string]any, 0)
			for _, possibleValue := range values {
				possible := possibleValue.(map[string]any)
				if possible["startIndex"] == symbol["startIndex"] {
					continue
				}
				if possible["line"].(int) < symbol["line"].(int) && possible["endLine"].(int) >= symbol["endLine"].(int) {
					containers = append(containers, possible)
				}
			}
			sort.SliceStable(containers, func(left, right int) bool { return containers[left]["line"].(int) < containers[right]["line"].(int) })
			names := make([]string, 0, len(containers))
			for _, container := range containers {
				names = append(names, container["name"].(string))
			}
			scope := strings.Join(names, ".")
			symbol["scopePath"] = scope
			if scope != "" {
				symbol["qualifiedName"] = scope + "." + symbol["name"].(string)
			}
		}
	}
	counts := map[string]int{}
	for _, value := range values {
		symbol := value.(map[string]any)
		key := symbol["kind"].(string) + ":" + symbol["qualifiedName"].(string)
		counts[key]++
	}
	for _, value := range values {
		symbol := value.(map[string]any)
		key := symbol["kind"].(string) + ":" + symbol["qualifiedName"].(string)
		symbol["identityAmbiguous"] = counts[key] > 1
		if !includeRanges {
			delete(symbol, "startIndex")
			delete(symbol, "endIndex")
		}
		delete(symbol, "matchEndIndex")
	}
	return values
}

func sortSymbols(values []any) []any {
	sort.SliceStable(values, func(left, right int) bool {
		l := values[left].(map[string]any)
		r := values[right].(map[string]any)
		if l["line"].(int) != r["line"].(int) {
			return l["line"].(int) < r["line"].(int)
		}
		return canonicaljson.CompareText(l["name"].(string), r["name"].(string)) < 0
	})
	return values
}

func extractSymbolsInternal(text, language string, lines []int, includeRanges bool) []any {
	masked := maskNonCode(text, language)
	switch language {
	case "javascript", "typescript":
		return enrichSymbols(text, masked, language, regexSymbols(masked, lines, []symbolPattern{
			{Kind: "function", Regex: javascriptFunction, Group: 3},
			{Kind: "class", Regex: javascriptClass, Group: 2},
			{Kind: "binding", Regex: javascriptBinding, Group: 3},
		}, maximumSymbolsPerFile), lines, includeRanges)
	case "python":
		return enrichSymbols(text, masked, language, regexSymbols(masked, lines, []symbolPattern{
			{Kind: "function", Regex: pythonFunction, Group: 2},
			{Kind: "class", Regex: pythonClass, Group: 1},
		}, maximumSymbolsPerFile), lines, includeRanges)
	case "markdown":
		return enrichSymbols(text, text, language, regexSymbols(text, lines, []symbolPattern{{Kind: "heading", Regex: markdownHeading, Group: 1}}, maximumSymbolsPerFile), lines, includeRanges)
	default:
		return []any{}
	}
}

func extractSymbols(text, language string, lines []int) []any {
	return extractSymbolsInternal(text, language, lines, false)
}

func addDependency(result *[]any, seen map[string]bool, specifier, kind string, line int) {
	key := kind + ":" + specifier
	if specifier == "" || seen[key] {
		return
	}
	seen[key] = true
	*result = append(*result, map[string]any{"specifier": specifier, "kind": kind, "line": line})
}

func extractDependencies(text, language, base string, lines []int) []any {
	result := make([]any, 0)
	seen := map[string]bool{}
	if language == "javascript" || language == "typescript" {
		for _, match := range javascriptDependency.FindAllStringSubmatchIndex(text, -1) {
			addDependency(&result, seen, text[match[4]:match[5]], "module", lineAt(lines, match[0]))
		}
	} else if language == "python" {
		for _, match := range pythonDependency.FindAllStringSubmatchIndex(text, -1) {
			addDependency(&result, seen, text[match[4]:match[5]], "module", lineAt(lines, match[0]))
		}
	}
	if base == "package.json" {
		var parsed map[string]any
		if json.Unmarshal([]byte(text), &parsed) == nil {
			for _, section := range []string{"dependencies", "devDependencies", "peerDependencies", "optionalDependencies"} {
				if entries, ok := parsed[section].(map[string]any); ok {
					for name := range entries {
						addDependency(&result, seen, name, section, 1)
					}
				}
			}
		}
	}
	sort.SliceStable(result, func(left, right int) bool {
		l := result[left].(map[string]any)
		r := result[right].(map[string]any)
		if compared := canonicaljson.CompareText(l["kind"].(string), r["kind"].(string)); compared != 0 {
			return compared < 0
		}
		return canonicaljson.CompareText(l["specifier"].(string), r["specifier"].(string)) < 0
	})
	return result
}

func addBinding(result *[]any, local, imported, specifier string, namespace bool) {
	if local == "" || specifier == "" {
		return
	}
	*result = append(*result, map[string]any{
		"local": local, "imported": imported, "specifier": specifier, "namespace": namespace,
	})
}

func capture(text string, match []int, group int) string {
	offset := group * 2
	if offset+1 >= len(match) || match[offset] < 0 {
		return ""
	}
	return text[match[offset]:match[offset+1]]
}

func extractBindings(text, language string) []any {
	result := make([]any, 0)
	if language == "javascript" || language == "typescript" {
		for _, match := range javascriptImport.FindAllStringSubmatchIndex(text, -1) {
			clause := strings.TrimSpace(capture(text, match, 1))
			specifier := capture(text, match, 2)
			if namespace := javascriptNamespace.FindStringSubmatch(clause); namespace != nil {
				addBinding(&result, namespace[1], "*", specifier, true)
			}
			if named := javascriptNamed.FindStringSubmatch(clause); named != nil {
				for _, item := range strings.Split(named[1], ",") {
					parts := javascriptAsSplit.Split(strings.TrimSpace(item), -1)
					if parts[0] != "" {
						local := parts[0]
						if len(parts) > 1 {
							local = parts[1]
						}
						addBinding(&result, local, parts[0], specifier, false)
					}
				}
			}
			defaultBinding := strings.TrimSpace(strings.Split(clause, ",")[0])
			if identifier.MatchString(defaultBinding) {
				addBinding(&result, defaultBinding, "default", specifier, false)
			}
		}
		for _, match := range javascriptRequireNamed.FindAllStringSubmatchIndex(text, -1) {
			for _, item := range strings.Split(capture(text, match, 2), ",") {
				parts := javascriptColonSplit.Split(strings.TrimSpace(item), -1)
				if parts[0] != "" {
					local := parts[0]
					if len(parts) > 1 {
						local = parts[1]
					}
					addBinding(&result, local, parts[0], capture(text, match, 3), false)
				}
			}
		}
		for _, match := range javascriptRequire.FindAllStringSubmatchIndex(text, -1) {
			addBinding(&result, capture(text, match, 2), "*", capture(text, match, 3), true)
		}
	} else if language == "python" {
		for _, match := range pythonFromImport.FindAllStringSubmatchIndex(text, -1) {
			for _, item := range strings.Split(capture(text, match, 2), ",") {
				parts := pythonAsSplit.Split(strings.TrimSpace(item), -1)
				if parts[0] != "" {
					local := parts[0]
					if len(parts) > 1 {
						local = parts[1]
					}
					addBinding(&result, local, parts[0], capture(text, match, 1), false)
				}
			}
		}
		for _, match := range pythonImport.FindAllStringSubmatchIndex(text, -1) {
			module := capture(text, match, 1)
			local := capture(text, match, 3)
			if local == "" {
				local = strings.Split(module, ".")[0]
			}
			addBinding(&result, local, "*", module, true)
		}
	}
	sort.SliceStable(result, func(left, right int) bool {
		l := result[left].(map[string]any)
		r := result[right].(map[string]any)
		for _, field := range []string{"local", "specifier", "imported"} {
			if compared := canonicaljson.CompareText(l[field].(string), r[field].(string)); compared != 0 {
				return compared < 0
			}
		}
		return false
	})
	return result
}

func prefixByUTF16(text string, byteIndex, maximumUnits int) string {
	units := make([]uint16, 0, maximumUnits)
	prefix := text[:byteIndex]
	for len(prefix) > 0 && len(units) < maximumUnits {
		r, size := utf8.DecodeLastRuneInString(prefix)
		prefix = prefix[:len(prefix)-size]
		encoded := utf16.Encode([]rune{r})
		if len(units)+len(encoded) > maximumUnits {
			encoded = encoded[len(encoded)-(maximumUnits-len(units)):]
		}
		units = append(encoded, units...)
	}
	return string(utf16.Decode(units))
}

func maskNonCode(text, language string) string {
	masked := []byte(text)
	mode := "code"
	quote := byte(0)
	escaped := false
	for index := 0; index < len(masked); index++ {
		character := text[index]
		next := byte(0)
		if index+1 < len(text) {
			next = text[index+1]
		}
		preserve := character == '\n' || character == '\r'
		switch mode {
		case "line-comment":
			if character == '\n' {
				mode = "code"
			} else {
				masked[index] = ' '
			}
			continue
		case "block-comment":
			if character == '*' && next == '/' {
				masked[index], masked[index+1] = ' ', ' '
				index++
				mode = "code"
			} else if !preserve {
				masked[index] = ' '
			}
			continue
		case "string":
			if !preserve {
				masked[index] = ' '
			}
			if escaped {
				escaped = false
			} else if character == '\\' {
				escaped = true
			} else if character == quote {
				mode = "code"
			}
			continue
		case "triple-string":
			if index+2 < len(text) && text[index] == quote && text[index+1] == quote && text[index+2] == quote {
				masked[index], masked[index+1], masked[index+2] = ' ', ' ', ' '
				index += 2
				mode = "code"
			} else if !preserve {
				masked[index] = ' '
			}
			continue
		}
		if language == "python" && character == '#' {
			masked[index] = ' '
			mode = "line-comment"
		} else if language != "python" && character == '/' && next == '/' {
			masked[index], masked[index+1] = ' ', ' '
			index++
			mode = "line-comment"
		} else if language != "python" && character == '/' && next == '*' {
			masked[index], masked[index+1] = ' ', ' '
			index++
			mode = "block-comment"
		} else if language == "python" && index+2 < len(text) && (text[index:index+3] == "'''" || text[index:index+3] == "\"\"\"") {
			quote = character
			masked[index], masked[index+1], masked[index+2] = ' ', ' ', ' '
			index += 2
			mode = "triple-string"
		} else if character == '\'' || character == '"' || (language != "python" && character == '`') {
			quote = character
			masked[index] = ' '
			mode = "string"
		}
	}
	return string(masked)
}

func extractCalls(text, language string, lines []int) []any {
	if language != "javascript" && language != "typescript" && language != "python" {
		return []any{}
	}
	excluded := map[string]bool{
		"if": true, "for": true, "while": true, "switch": true, "catch": true,
		"function": true, "return": true, "typeof": true, "new": true,
		"class": true, "def": true, "with": true, "assert": true, "lambda": true,
	}
	masked := maskNonCode(text, language)
	symbols := extractSymbolsInternal(text, language, lines, true)
	result := make([]any, 0)
	for _, match := range callPattern.FindAllStringSubmatchIndex(masked, -1) {
		callee := capture(masked, match, 1)
		if excluded[callee] || declarationPrefix.MatchString(prefixByUTF16(masked, match[0], 24)) {
			continue
		}
		callIndex := match[0]
		callLine := lineAt(lines, callIndex)
		var caller map[string]any
		for _, value := range symbols {
			symbol := value.(map[string]any)
			if symbol["kind"] != "function" && symbol["kind"] != "binding" {
				continue
			}
			startIndex, startOK := symbol["startIndex"].(int)
			endIndex, endOK := symbol["endIndex"].(int)
			if startOK && endOK && startIndex < callIndex && callIndex < endIndex {
				if caller == nil || endIndex-startIndex < caller["endIndex"].(int)-caller["startIndex"].(int) {
					caller = symbol
				}
			}
		}
		callerName := any(nil)
		callerAmbiguous := false
		if caller != nil {
			callerName = caller["qualifiedName"]
			callerAmbiguous = caller["identityAmbiguous"].(bool)
		}
		result = append(result, map[string]any{"callee": callee, "line": callLine,
			"callerQualifiedName": callerName, "callerIdentityAmbiguous": callerAmbiguous})
	}
	sort.SliceStable(result, func(left, right int) bool {
		l := result[left].(map[string]any)
		r := result[right].(map[string]any)
		if l["line"].(int) != r["line"].(int) {
			return l["line"].(int) < r["line"].(int)
		}
		return canonicaljson.CompareText(l["callee"].(string), r["callee"].(string)) < 0
	})
	return result
}

func languageForSource(extension, base string) string {
	if base == "Dockerfile" {
		return "dockerfile"
	}
	languages := map[string]string{
		".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
		".ts": "typescript", ".tsx": "typescript", ".mts": "typescript",
		".py": "python", ".go": "go", ".rs": "rust", ".java": "java",
		".kt": "kotlin", ".kts": "kotlin", ".cs": "csharp", ".rb": "ruby",
		".php": "php", ".md": "markdown", ".json": "json", ".yaml": "yaml",
		".yml": "yaml", ".toml": "toml", ".html": "html", ".css": "css",
		".sql": "sql", ".ps1": "powershell", ".sh": "shell", ".vue": "vue",
		".svelte": "svelte",
	}
	if language, ok := languages[extension]; ok {
		return language
	}
	if strings.HasPrefix(extension, ".") && len(extension) > 1 {
		return extension[1:]
	}
	return "text"
}

func classifySourcePath(relative, extension string) string {
	segments := strings.Split(strings.ToLower(relative), "/")
	base := segments[len(segments)-1]
	for _, segment := range segments {
		if segment == "test" || segment == "tests" || segment == "__tests__" {
			return "test"
		}
	}
	if matched, _ := regexp.MatchString(`(^|[._-])(test|spec)\.`, base); matched {
		return "test"
	}
	if extension == ".md" {
		return "documentation"
	}
	for _, segment := range segments {
		if segment == "docs" {
			return "documentation"
		}
	}
	if extension == ".json" || extension == ".yaml" || extension == ".yml" || extension == ".toml" || strings.HasPrefix(base, ".") {
		return "configuration"
	}
	return "source"
}

func decodeUTF8(raw []byte) string {
	var output strings.Builder
	for len(raw) > 0 {
		r, size := utf8.DecodeRune(raw)
		if r == utf8.RuneError && size == 1 {
			output.WriteRune(utf8.RuneError)
			raw = raw[1:]
			continue
		}
		output.WriteRune(r)
		raw = raw[size:]
	}
	return output.String()
}

func emptySkipped() map[string]any {
	return map[string]any{
		"excludedDirectory":  0,
		"managedProjection":  0,
		"unsupportedType":    0,
		"tooLarge":           0,
		"symlink":            0,
		"outsideSourceScope": 0,
	}
}

func withinRoot(relative string, root string) bool {
	return relative == root || strings.HasPrefix(relative, root+"/")
}

func sourceScopeAllows(relative string, input scanInput, directory bool) bool {
	for _, root := range input.ExcludeRoots {
		if withinRoot(relative, root) {
			return false
		}
	}
	if len(input.IncludeRoots) == 0 {
		return true
	}
	for _, root := range input.IncludeRoots {
		if withinRoot(relative, root) || (directory && strings.HasPrefix(root, relative+"/")) {
			return true
		}
	}
	return false
}

func increment(skipped map[string]any, field string) {
	skipped[field] = skipped[field].(int) + 1
}

func excludesOwnedLodeDirectory(input scanInput, relative string, info os.FileInfo, owned bool) (bool, error) {
	if !owned {
		return false, nil
	}
	if relative == ".lode" {
		return true, nil
	}
	// Only a root case variant on Windows is even a candidate. SameFile, not
	// spelling, proves that the token resolves to this actual directory.
	if runtime.GOOS != "windows" || strings.ToLower(relative) != ".lode" {
		return false, nil
	}
	selected, err := os.Lstat(filepath.Join(input.ProjectRoot, ".lode"))
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return info.IsDir() && selected.IsDir() && os.SameFile(info, selected), nil
}

func Scan(data []byte, limits Limits) (any, *OperationError) {
	input, inputError := parseInput(data)
	if inputError != nil {
		return nil, inputError
	}
	producer := ProducerName
	if input.SourceScope["protocol"].(map[string]any)["name"] == "lode-agent-core-repository-source-scope" {
		producer = LodeProducerName
	}
	if limits.ExpectedProducer != "" && limits.ExpectedProducer != producer {
		return nil, operationError("INVALID_REPOSITORY_SOURCE_SCOPE", "Repository source scope contract is invalid.")
	}
	stat, err := os.Stat(input.ProjectRoot)
	if err != nil || !stat.IsDir() {
		return nil, operationError("REPOSITORY_SCAN_ROOT_INVALID", "Repository scan root is not a directory.")
	}
	managed := map[string]bool{}
	for _, value := range input.ManagedRootFiles {
		managed[value] = true
	}
	ownedLodeRoot := producer == LodeProducerName && managed[".lode"]
	files := make([]any, 0)
	skipped := emptySkipped()
	totalBytes := 0
	stack := []string{input.ProjectRoot}
	for len(stack) > 0 {
		directory := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		entries, readErr := os.ReadDir(directory)
		if readErr != nil {
			return nil, operationError("REPOSITORY_SCAN_READ_FAILED", readErr.Error())
		}
		sort.Slice(entries, func(left, right int) bool {
			return canonicaljson.CompareText(entries[left].Name(), entries[right].Name()) < 0
		})
		for _, entry := range entries {
			absolute := filepath.Join(directory, entry.Name())
			relative, relativeErr := filepath.Rel(input.ProjectRoot, absolute)
			if relativeErr != nil {
				return nil, operationError("REPOSITORY_SCAN_READ_FAILED", relativeErr.Error())
			}
			relative = filepath.ToSlash(relative)
			if entry.Type()&os.ModeSymlink != 0 {
				increment(skipped, "symlink")
				continue
			}
			info, infoErr := entry.Info()
			if infoErr != nil {
				return nil, operationError("REPOSITORY_SCAN_READ_FAILED", infoErr.Error())
			}
			if info.IsDir() {
				excluded := excludedDirectories[strings.ToLower(entry.Name())]
				if !excluded {
					var identityErr error
					excluded, identityErr = excludesOwnedLodeDirectory(input, relative, info, ownedLodeRoot)
					if identityErr != nil {
						return nil, operationError("REPOSITORY_SCAN_READ_FAILED", identityErr.Error())
					}
				}
				if excluded {
					increment(skipped, "excludedDirectory")
				} else if !sourceScopeAllows(relative, input, true) {
					increment(skipped, "outsideSourceScope")
				} else {
					stack = append(stack, absolute)
				}
				continue
			}
			if !info.Mode().IsRegular() {
				increment(skipped, "unsupportedType")
				continue
			}
			if !sourceScopeAllows(relative, input, false) {
				increment(skipped, "outsideSourceScope")
				continue
			}
			if managed[relative] {
				increment(skipped, "managedProjection")
				continue
			}
			base := entry.Name()
			extension := strings.ToLower(filepath.Ext(base))
			if !textExtensions[extension] && base != "Dockerfile" {
				increment(skipped, "unsupportedType")
				continue
			}
			if info.Size() > int64(limits.MaxFileBytes) {
				increment(skipped, "tooLarge")
				continue
			}
			raw, fileErr := os.ReadFile(absolute)
			if fileErr != nil {
				return nil, operationError("REPOSITORY_SCAN_READ_FAILED", fileErr.Error())
			}
			if len(raw) > limits.MaxFileBytes {
				increment(skipped, "tooLarge")
				continue
			}
			if len(files) >= limits.MaxFiles {
				return nil, operationError("REPOSITORY_SCAN_FILE_LIMIT", fmt.Sprintf("Repository scan exceeds %d files.", limits.MaxFiles))
			}
			if totalBytes+len(raw) > limits.MaxTotalBytes {
				return nil, operationError("REPOSITORY_SCAN_TOTAL_BYTES_LIMIT", fmt.Sprintf("Repository scan exceeds %d total bytes.", limits.MaxTotalBytes))
			}
			content := decodeUTF8(raw)
			language := languageForSource(extension, base)
			lines := newlineOffsets(content)
			bindings := extractBindings(content, language)
			calls := extractCalls(content, language, lines)
			files = append(files, map[string]any{
				"path":           relative,
				"digest":         digest(raw),
				"freshness":      "active",
				"bytes":          len(raw),
				"classification": classifySourcePath(relative, extension),
				"language":       language,
				"symbols":        extractSymbols(content, language, lines),
				"dependencies":   extractDependencies(content, language, base, lines),
				"semanticFacts": map[string]any{
					"bindings": bindings,
					"calls":    calls,
				},
			})
			totalBytes += len(raw)
		}
	}
	sort.SliceStable(files, func(left, right int) bool {
		return canonicaljson.CompareText(files[left].(map[string]any)["path"].(string), files[right].(map[string]any)["path"].(string)) < 0
	})
	symbolCount := 0
	dependencyCount := 0
	bindingCount := 0
	callCount := 0
	for _, value := range files {
		file := value.(map[string]any)
		symbolCount += len(file["symbols"].([]any))
		dependencyCount += len(file["dependencies"].([]any))
		facts := file["semanticFacts"].(map[string]any)
		bindingCount += len(facts["bindings"].([]any))
		callCount += len(facts["calls"].([]any))
	}
	payload := map[string]any{
		"schemaVersion":         1,
		"kind":                  "RepositoryScanResult",
		"protocol":              map[string]any{"name": producer, "version": ProducerVersion},
		"sourceAnalysisVersion": SourceAnalysisVersion,
		"authority":             "derived-evidence-only",
		"instructionAuthority":  false,
		"promotionAuthority":    false,
		"sourceScope":           input.SourceScope,
		"files":                 files,
		"skipped":               skipped,
		"summary": map[string]any{
			"fileCount":       len(files),
			"totalBytes":      totalBytes,
			"symbolCount":     symbolCount,
			"dependencyCount": dependencyCount,
			"bindingCount":    bindingCount,
			"callCount":       callCount,
		},
	}
	canonical, canonicalErr := canonicaljson.Marshal(payload)
	if canonicalErr != nil {
		return nil, operationError("REPOSITORY_SCAN_ENCODING_FAILED", canonicalErr.Error())
	}
	scanHash := digest(canonical)
	payload["scanId"] = "repository-scan-" + scanHash[:24]
	payload["scanHash"] = scanHash
	return payload, nil
}

// FixtureInput constructs a canonical input for Go unit tests.
func FixtureInput(root string, managed []string) []byte {
	return FixtureInputWithScope(root, managed, []any{}, []any{})
}

// FixtureInputWithScope constructs a canonical scoped input for Go unit tests.
func FixtureInputWithScope(root string, managed []string, includeRoots []any, excludeRoots []any) []byte {
	scopePayload := map[string]any{
		"schemaVersion": 1, "kind": "RepositorySourceScope",
		"protocol":     map[string]any{"name": "head-agent-core-repository-source-scope", "version": "0.1.0"},
		"includeRoots": includeRoots, "excludeRoots": excludeRoots,
		"authority": "user-selected-observation-boundary", "instructionAuthority": false, "promotionAuthority": false,
	}
	canonicalScope, _ := canonicaljson.Marshal(scopePayload)
	scopeHash := digest(canonicalScope)
	scopePayload["sourceScopeId"] = "repository-source-scope-" + scopeHash[:24]
	scopePayload["sourceScopeHash"] = scopeHash
	value := map[string]any{
		"schemaVersion": 1, "kind": "RepositoryScanInput", "projectRoot": filepath.Clean(root), "managedRootFiles": managed, "sourceScope": scopePayload,
	}
	encoded, _ := canonicaljson.Marshal(value)
	return encoded
}
