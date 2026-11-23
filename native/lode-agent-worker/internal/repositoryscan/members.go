package repositoryscan

import (
	"regexp"
	"sort"
	"strings"
)

// Members that are declarations, ported rule for rule from
// scripts/lib/world/source-analysis.mjs (methodDefinitionSites,
// javascriptMembers): methods of a JavaScript / TypeScript class body as
// <Class>.<method>, and function-valued members of an object literal bound to
// a module-level name as <binding>.<member>. A method definition site is not a
// call. Every character these rules test is ASCII, so byte offsets here and
// UTF-16 offsets there land on the same characters.

// jsSpaceClass is what JavaScript's \s matches; RE2's \s is ASCII only, so
// the patterns below spell it out to read the same text the same way.
const jsSpaceClass = `[\t\n\v\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]`

func jsRegexp(pattern string) *regexp.Regexp {
	return regexp.MustCompile(strings.ReplaceAll(pattern, `\s`, jsSpaceClass))
}

var (
	methodSitePattern     = jsRegexp(`(#?)([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*<[^<>()\n]*>)?\s*\(`)
	signatureSitePattern  = jsRegexp(`(#?)([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*(?:<[^<>()\n]*>)?\s*\(`)
	interfacePattern      = jsRegexp(`\binterface\s+[A-Za-z_$][A-Za-z0-9_$]*[^{;]*\{`)
	literalBindingPattern = jsRegexp(`\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;{]+)?=\s*\{`)
	keyMemberPattern      = jsRegexp(`([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)`)
	fieldMemberPattern    = jsRegexp(`(#?[A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;{}()]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)`)
	// A binding that may hold a function: "const name" followed by ":" or "="
	// (the character after it is checked in Go; RE2 has no look-ahead).
	bindingStartRegexp    = jsRegexp(`\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]`)
	classExpressionRegexp = jsRegexp(`\b(export\s+)?(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*class\b`)
	defaultClassRegexp    = jsRegexp(`\bexport\s+default\s+(class)\b\s*(\{|extends\b)`)
)

var notMethodNames = map[string]bool{
	"if": true, "for": true, "while": true, "switch": true, "catch": true, "with": true, "function": true,
	"return": true, "typeof": true, "new": true, "class": true, "do": true, "else": true, "try": true,
	"finally": true, "yield": true, "await": true, "delete": true, "void": true, "throw": true, "in": true,
	"of": true, "instanceof": true, "super": true, "import": true, "export": true, "case": true, "default": true,
}

var memberModifiers = map[string]bool{
	"static": true, "async": true, "get": true, "set": true, "public": true, "private": true,
	"protected": true, "readonly": true, "override": true, "abstract": true,
}

type methodSite struct {
	nameIndex  int
	startIndex int
	name       string
	open       int
	close      int
}

func isBlank(character byte) bool {
	return character == ' ' || character == '\t' || character == '\n' || character == '\r' || character == '\v' || character == '\f'
}

func isLetter(character byte) bool {
	return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
}

func isMemberBoundary(character byte) bool {
	return isJavaScriptWord(character) || character == '.' || character == '@' || character == '#'
}

func byteAt(text string, index int) byte {
	if index < 0 || index >= len(text) {
		return 0
	}
	return text[index]
}

// bracketPartners pairs ( [ { with ) ] } by plain counting (a closer pairs
// with the most recent opener of any kind); bracePartners counts braces only.
func bracketPartners(masked string) []int {
	partner := make([]int, len(masked))
	for index := range partner {
		partner[index] = -1
	}
	stack := []int{}
	for index := 0; index < len(masked); index++ {
		switch masked[index] {
		case '(', '[', '{':
			stack = append(stack, index)
		case ')', ']', '}':
			if len(stack) > 0 {
				open := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				partner[open] = index
				partner[index] = open
			}
		}
	}
	return partner
}

func bracePartners(masked string) []int {
	partner := make([]int, len(masked))
	for index := range partner {
		partner[index] = -1
	}
	stack := []int{}
	for index := 0; index < len(masked); index++ {
		if masked[index] == '{' {
			stack = append(stack, index)
		} else if masked[index] == '}' && len(stack) > 0 {
			partner[stack[len(stack)-1]] = index
			stack = stack[:len(stack)-1]
		}
	}
	return partner
}

// precededByFunction tells whether "function" (optionally with "*") stands
// right before index across blanks only; no fixed window, so byte and UTF-16
// offsets read it the same.
func precededByFunction(masked string, index int) bool {
	cursor := index - 1
	for cursor >= 0 && isBlank(masked[cursor]) {
		cursor--
	}
	if cursor >= 0 && masked[cursor] == '*' {
		cursor--
		for cursor >= 0 && isBlank(masked[cursor]) {
			cursor--
		}
	}
	end := cursor + 1
	for cursor >= 0 && isLetter(masked[cursor]) {
		cursor--
	}
	return masked[cursor+1:end] == "function" && !(cursor >= 0 && (isJavaScriptWord(masked[cursor]) || masked[cursor] == '.'))
}

// startsMember tells whether a member starts at index: after its modifiers,
// only blanks stand between it and a "{", ";", "}", "," or a line break.
func startsMember(masked string, index int) bool {
	cursor := memberSignatureStart(masked, index) - 1
	for cursor >= 0 && (masked[cursor] == ' ' || masked[cursor] == '\t') {
		cursor--
	}
	return cursor < 0 || strings.IndexByte("{};,\n\r", masked[cursor]) >= 0
}

type signatureSite struct {
	nameIndex int
	name      string
	owner     int
}

// signatureSites finds TypeScript signatures without a body directly in a
// class or interface body ("abstract render(): void;", overloads): neither
// calls nor declarations.
func signatureSites(masked string, classBodyOpens []int, brackets []int) []signatureSite {
	opens := map[int]bool{}
	for _, open := range classBodyOpens {
		opens[open] = true
	}
	for _, match := range interfacePattern.FindAllStringIndex(masked, -1) {
		opens[match[1]-1] = true
	}
	if len(opens) == 0 {
		return []signatureSite{}
	}
	if brackets == nil {
		brackets = bracketPartners(masked)
	}
	type candidate struct {
		nameIndex int
		name      string
	}
	candidates := []candidate{}
	for _, match := range signatureSitePattern.FindAllStringSubmatchIndex(masked, -1) {
		startIndex := match[0]
		if startIndex > 0 && isMemberBoundary(masked[startIndex-1]) {
			continue
		}
		private := masked[match[2]:match[3]]
		name := masked[match[4]:match[5]]
		if private == "" && notMethodNames[name] {
			continue
		}
		closeIndex := brackets[match[1]-1]
		if closeIndex < 0 || !startsMember(masked, startIndex) {
			continue
		}
		after := closeIndex + 1
		for after < len(masked) && (masked[after] == ' ' || masked[after] == '\t') {
			after++
		}
		if byteAt(masked, after) == ':' {
			for after < len(masked) && strings.IndexByte(";{}\n\r=", masked[after]) < 0 {
				after++
			}
		}
		character := byteAt(masked, after)
		if character == '\n' || character == '\r' {
			// A line end ends the signature unless the body follows on the next line.
			next := after
			for next < len(masked) && isBlank(masked[next]) {
				next++
			}
			if byteAt(masked, next) == '{' {
				continue
			}
		} else if character != ';' && character != '}' && character != ',' {
			continue
		}
		candidates = append(candidates, candidate{nameIndex: startIndex + len(private), name: private + name})
	}
	indexes := []int{}
	for _, item := range candidates {
		indexes = append(indexes, item.nameIndex)
	}
	owners := innermostBraces(masked, uniqueSorted(indexes))
	result := []signatureSite{}
	for _, item := range candidates {
		if owner := owners[item.nameIndex]; opens[owner] {
			result = append(result, signatureSite{nameIndex: item.nameIndex, name: item.name, owner: owner})
		}
	}
	return result
}

// Everything between ")" and "{" must be code in the original text too (a
// template's blanked text is not).
func methodDefinitionSites(masked, text string, brackets []int) []methodSite {
	sites := []methodSite{}
	if brackets == nil {
		brackets = bracketPartners(masked)
	}
	braces := bracePartners(masked)
	for _, match := range methodSitePattern.FindAllStringSubmatchIndex(masked, -1) {
		startIndex := match[0]
		if startIndex > 0 && isMemberBoundary(masked[startIndex-1]) {
			continue
		}
		private := masked[match[2]:match[3]]
		name := masked[match[4]:match[5]]
		if private == "" && notMethodNames[name] {
			continue
		}
		if precededByFunction(masked, startIndex) {
			continue
		}
		closeIndex := brackets[match[1]-1]
		if closeIndex < 0 {
			continue
		}
		after := closeIndex + 1
		for after < len(masked) && isBlank(masked[after]) {
			after++
		}
		if byteAt(masked, after) == ':' {
			// A TypeScript return type: "): Type {", read as a function's (0.3.4).
			after = typeEnd(masked, text, brackets, after+1, untilBody)
			if after < 0 {
				continue
			}
		}
		if byteAt(masked, after) != '{' || masked[closeIndex+1:after] != text[closeIndex+1:after] {
			continue
		}
		bodyClose := braces[after]
		if bodyClose < 0 {
			continue
		}
		sites = append(sites, methodSite{nameIndex: startIndex + len(private), startIndex: startIndex, name: private + name, open: after, close: bodyClose})
	}
	return sites
}

// innermostBraces returns, for each index (ascending, unique), the innermost
// "{" still open before it, or -1.
func innermostBraces(masked string, indexes []int) map[int]int {
	result := map[int]int{}
	stack := []int{}
	cursor := 0
	for index := 0; index <= len(masked) && cursor < len(indexes); index++ {
		for cursor < len(indexes) && indexes[cursor] == index {
			if len(stack) > 0 {
				result[indexes[cursor]] = stack[len(stack)-1]
			} else {
				result[indexes[cursor]] = -1
			}
			cursor++
		}
		if index < len(masked) {
			if masked[index] == '{' {
				stack = append(stack, index)
			} else if masked[index] == '}' && len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		}
	}
	return result
}

// bracketDepths returns the ( [ { depth at each index (ascending, unique).
func bracketDepths(masked string, indexes []int) map[int]int {
	result := map[int]int{}
	depth := 0
	cursor := 0
	for index := 0; index <= len(masked) && cursor < len(indexes); index++ {
		for cursor < len(indexes) && indexes[cursor] == index {
			result[indexes[cursor]] = depth
			cursor++
		}
		if index < len(masked) {
			switch masked[index] {
			case '(', '[', '{':
				depth++
			case ')', ']', '}':
				if depth > 0 {
					depth--
				}
			}
		}
	}
	return result
}

func memberSignatureStart(masked string, startIndex int) int {
	signatureStart := startIndex
	for {
		cursor := signatureStart
		for cursor > 0 && (masked[cursor-1] == ' ' || masked[cursor-1] == '\t') {
			cursor--
		}
		if cursor > 0 && masked[cursor-1] == '*' {
			signatureStart = cursor - 1
			continue
		}
		wordStart := cursor
		for wordStart > 0 && isLetter(masked[wordStart-1]) {
			wordStart--
		}
		if wordStart < cursor && memberModifiers[masked[wordStart:cursor]] && !(wordStart > 0 && (isJavaScriptWord(masked[wordStart-1]) || masked[wordStart-1] == '.')) {
			signatureStart = wordStart
			continue
		}
		return signatureStart
	}
}

func uniqueSorted(values []int) []int {
	seen := map[int]bool{}
	result := []int{}
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	sort.Ints(result)
	return result
}

// javascriptMembers returns the member declarations of a file. values are the
// file's other declarations after scopes were set; a class carries its body
// "{" as bodyOpen.
func javascriptMembers(text, masked string, values []any, sites []methodSite, lines []int) []any {
	literalOpens := map[int]string{}
	candidates := literalBindingPattern.FindAllStringSubmatchIndex(masked, -1)
	candidateStarts := []int{}
	for _, match := range candidates {
		candidateStarts = append(candidateStarts, match[0])
	}
	depths := bracketDepths(masked, uniqueSorted(candidateStarts))
	literalOrder := []int{}
	for _, match := range candidates {
		if depths[match[0]] == 0 {
			open := match[1] - 1
			if _, known := literalOpens[open]; !known {
				literalOrder = append(literalOrder, open)
			}
			literalOpens[open] = masked[match[2]:match[3]]
		}
	}
	type keyMatch struct{ index, end, nameEnd int }
	keyMembers := []keyMatch{}
	braces := bracePartners(masked)
	for _, open := range literalOrder {
		closeIndex := braces[open]
		// One match at a time from the literal's "{", stopping at its "}" (as
		// the JavaScript loop does), instead of every match to the file's end.
		for offset := open + 1; offset < len(masked); {
			match := keyMemberPattern.FindStringSubmatchIndex(masked[offset:])
			if match == nil {
				break
			}
			index := offset + match[0]
			if closeIndex >= 0 && index >= closeIndex {
				break
			}
			if !(index > 0 && (isJavaScriptWord(masked[index-1]) || masked[index-1] == '.' || masked[index-1] == '#')) {
				keyMembers = append(keyMembers, keyMatch{index: index, end: offset + match[1], nameEnd: offset + match[3]})
			}
			offset += match[1]
		}
	}
	// A class body "{" belongs to the class whose declaration starts last (the
	// innermost one when two resolve to the same "{").
	classOf := map[int]map[string]any{}
	for _, value := range values {
		symbol := value.(map[string]any)
		if open, ok := symbol["bodyOpen"].(int); ok {
			if known, exists := classOf[open]; !exists || known["startIndex"].(int) < symbol["startIndex"].(int) {
				classOf[open] = symbol
			}
		}
	}
	// Class fields holding a function, directly in a class body.
	type fieldMatch struct{ index, end, nameEnd int }
	fields := []fieldMatch{}
	classBodies := []int{}
	for open := range classOf {
		classBodies = append(classBodies, open)
	}
	sort.Ints(classBodies)
	for _, open := range classBodies {
		closeIndex := braces[open]
		for offset := open + 1; offset < len(masked); {
			match := fieldMemberPattern.FindStringSubmatchIndex(masked[offset:])
			if match == nil {
				break
			}
			index := offset + match[0]
			if closeIndex >= 0 && index >= closeIndex {
				break
			}
			if !(index > 0 && (isJavaScriptWord(masked[index-1]) || masked[index-1] == '.' || masked[index-1] == '#')) && startsMember(masked, index) {
				fields = append(fields, fieldMatch{index: index, end: offset + match[1], nameEnd: offset + match[3]})
			}
			offset += match[1]
		}
	}
	ownerIndexes := []int{}
	for _, site := range sites {
		ownerIndexes = append(ownerIndexes, site.nameIndex)
	}
	for _, key := range keyMembers {
		ownerIndexes = append(ownerIndexes, key.index)
	}
	for _, field := range fields {
		ownerIndexes = append(ownerIndexes, field.index)
	}
	owners := innermostBraces(masked, uniqueSorted(ownerIndexes))
	members := []any{}
	push := func(name, scopePath string, startIndex, signatureStart, signatureEnd, endIndex int) {
		last := endIndex - 1
		if last < startIndex {
			last = startIndex
		}
		members = append(members, map[string]any{
			"name":          name,
			"kind":          "function",
			"line":          lineAt(lines, startIndex),
			"endLine":       lineAt(lines, last),
			"scopePath":     scopePath,
			"qualifiedName": scopePath + "." + name,
			"signature":     normalizedSignature(text[signatureStart:signatureEnd]),
			"startIndex":    startIndex,
			"endIndex":      endIndex,
		})
	}
	for _, site := range sites {
		owner := owners[site.nameIndex]
		ownerClass, isClass := classOf[owner]
		literal, isLiteral := literalOpens[owner]
		if !isClass && !isLiteral {
			continue
		}
		scope := literal
		if isClass {
			scope = ownerClass["qualifiedName"].(string)
		}
		push(site.name, scope, site.startIndex, memberSignatureStart(masked, site.startIndex), site.open, site.close+1)
	}
	for _, key := range keyMembers {
		literal, isLiteral := literalOpens[owners[key.index]]
		if !isLiteral {
			continue
		}
		previous := key.index - 1
		for previous >= 0 && isBlank(masked[previous]) {
			previous--
		}
		if byteAt(masked, previous) != '{' && byteAt(masked, previous) != ',' {
			continue
		}
		open := -1
		if strings.HasSuffix(masked[key.index:key.end], "=>") {
			body := key.end
			for body < len(masked) && isBlank(masked[body]) {
				body++
			}
			if byteAt(masked, body) == '{' {
				open = body
			}
		} else if relative := strings.IndexByte(masked[key.end:], '{'); relative >= 0 {
			open = key.end + relative
		}
		closeIndex := -1
		if open >= 0 {
			closeIndex = braces[open]
		}
		endIndex := key.end
		if closeIndex >= 0 {
			endIndex = closeIndex + 1
		} else {
			// An expression body runs to the next "," or closing bracket of the literal.
			depth := 0
			for ; endIndex < len(masked); endIndex++ {
				character := masked[endIndex]
				if character == '(' || character == '[' || character == '{' {
					depth++
				} else if character == ')' || character == ']' || character == '}' {
					if depth == 0 {
						break
					}
					depth--
				} else if character == ',' && depth == 0 {
					break
				}
			}
		}
		signatureEnd := endIndex
		if closeIndex >= 0 {
			signatureEnd = open
		}
		push(masked[key.index:key.nameEnd], literal, key.index, key.index, signatureEnd, endIndex)
	}
	for _, field := range fields {
		ownerClass, isClass := classOf[owners[field.index]]
		if !isClass {
			continue
		}
		open := -1
		if strings.HasSuffix(masked[field.index:field.end], "=>") {
			body := field.end
			for body < len(masked) && isBlank(masked[body]) {
				body++
			}
			if byteAt(masked, body) == '{' {
				open = body
			}
		} else if relative := strings.IndexByte(masked[field.end:], '{'); relative >= 0 {
			open = field.end + relative
		}
		closeIndex := -1
		if open >= 0 {
			closeIndex = braces[open]
		}
		endIndex := field.end
		if closeIndex >= 0 {
			endIndex = closeIndex + 1
		} else {
			// An expression body runs to a ";", a line end or a closing bracket of
			// the class body; it starts at the first non-blank after "=>".
			for endIndex < len(masked) && isBlank(masked[endIndex]) {
				endIndex++
			}
			depth := 0
			for ; endIndex < len(masked); endIndex++ {
				character := masked[endIndex]
				if character == '(' || character == '[' || character == '{' {
					depth++
				} else if character == ')' || character == ']' || character == '}' {
					if depth == 0 {
						break
					}
					depth--
				} else if depth == 0 && (character == ';' || character == '\n') {
					break
				}
			}
		}
		signatureEnd := endIndex
		if closeIndex >= 0 {
			signatureEnd = open
		}
		push(masked[field.index:field.nameEnd], ownerClass["qualifiedName"].(string), field.index, memberSignatureStart(masked, field.index), signatureEnd, endIndex)
	}
	return members
}
